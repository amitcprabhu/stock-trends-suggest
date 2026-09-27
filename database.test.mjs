import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_ASSETS } from "./assets.mjs";
import { analyzePrices } from "./analysis.mjs";
import { createStore } from "./database.mjs";

async function withStore(callback, configuredAssets = DEFAULT_ASSETS) {
  const directory = await mkdtemp(join(tmpdir(), "trendsignal-test-"));
  const store = await createStore(join(directory, "trends.sqlite"), configuredAssets);
  try {
    await callback(store);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function sampleMarket(sessionOffset = 0) {
  const prices = Array.from({ length: 240 }, (_, index) => ({
    timestamp: Math.floor(Date.now() / 1000) - (240 - index + sessionOffset) * 86_400,
    close: 100 + index * 0.25 + 5 * Math.sin(index * 0.5),
    volume: 1000 + index
  }));
  return {
    symbol: "^NSEI",
    currency: "INR",
    exchange: "NSE",
    marketTime: prices.at(-1).timestamp,
    prices
  };
}

test("seeds the shared market universe and exposes the analyzer waiting state", async () => {
  await withStore((store) => {
    const dashboard = store.getDashboard();

    assert.equal(store.listAssets().length, 3);
    assert.ok(store.listAssets().every((asset) => asset.kind === "index"));
    assert.equal(dashboard.analyzer.status, "waiting");
    assert.equal(dashboard.assets[0].symbol, "^NSEI");
    assert.equal(dashboard.assets[0].analysis, null);
  });
});

test("limits new dashboard tracking to indexes without deleting archived stock history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trendsignal-index-migration-"));
  const databasePath = join(directory, "trends.sqlite");
  const archivedStock = {
    symbol: "INFY.NS", name: "Infosys", exchange: "NSE", kind: "stock"
  };
  const store = await createStore(databasePath, [...DEFAULT_ASSETS, archivedStock]);
  try {
    const market = sampleMarket();
    const stockMarket = { ...market, symbol: archivedStock.symbol };
    const analysis = analyzePrices(stockMarket.prices.map((point) => point.close));
    store.recordSuccess(archivedStock, stockMarket, analysis);
    store.close();

    const indexStore = await createStore(databasePath);
    try {
      assert.deepEqual(indexStore.listAssets().map((asset) => asset.symbol), DEFAULT_ASSETS.map((asset) => asset.symbol));
      assert.equal(indexStore.getDashboard().assets.length, 3);
      assert.equal(indexStore.getAnalysisHistory(archivedStock.symbol), null);
      assert.equal(indexStore.getPredictionAnalytics(archivedStock.symbol), null);
    } finally {
      indexStore.close();
    }

    const db = new DatabaseSync(databasePath);
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM analyses WHERE symbol = ?").get(archivedStock.symbol).count, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM predictions WHERE symbol = ?").get(archivedStock.symbol).count, 3);
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists analysis, daily prices, exchange and currency for the mobile API", async () => {
  await withStore((store) => {
    const market = sampleMarket();
    const asset = store.listAssets()[0];
    const analysis = analyzePrices(market.prices.map((point) => point.close));
    const analyzedAt = Date.now();
    const insight = {
      model: "test-model",
      summary: "Most daily trend indicators are positive.",
      drivers: ["The latest close is above the 20-day EMA."],
      risks: ["Daily data may be delayed."]
    };

    store.recordSuccess(asset, market, analysis, analyzedAt);
    store.recordInsight(asset, market.marketTime, insight, analyzedAt);
    store.setAnalyzerState("ready", { lastRunAt: analyzedAt });
    const dashboard = store.getDashboard();
    const saved = dashboard.assets[0];

    assert.equal(dashboard.generatedAt, analyzedAt);
    assert.equal(dashboard.analyzer.status, "ready");
    assert.equal(saved.currency, "INR");
    assert.equal(saved.providerExchange, "NSE");
    assert.equal(saved.prices.length, 240);
    assert.equal(saved.analysis.signal, analysis.signal);
    assert.equal(saved.analysis.alignedFactors, analysis.alignedFactors);
    assert.equal(saved.aiInsight.status, "ready");
    assert.equal(saved.aiInsight.summary, insight.summary);
    assert.deepEqual(saved.aiInsight.drivers, insight.drivers);
    assert.equal(store.getLatestInsight(asset.symbol).marketTime, market.marketTime);
    assert.equal(store.getAnalysisHistory(asset.symbol).length, 1);
  });
});

test("keeps only the configured rolling 90 days of analysis snapshots", async () => {
  await withStore((store) => {
    const asset = store.listAssets()[0];
    const market = sampleMarket();
    const analysis = analyzePrices(market.prices.map((point) => point.close));
    const now = Date.now();
    const oldInsight = {
      model: "test-model", summary: "Expired insight.", drivers: [], risks: []
    };
    const currentInsight = {
      model: "test-model", summary: "Current insight.", drivers: [], risks: []
    };
    const oldMarket = sampleMarket(91);
    const oldAnalysis = analyzePrices(oldMarket.prices.map((point) => point.close));
    store.recordSuccess(asset, oldMarket, oldAnalysis, now - 91 * 24 * 60 * 60 * 1000);
    store.recordInsight(asset, oldMarket.marketTime, oldInsight, now - 91 * 24 * 60 * 60 * 1000);
    store.recordSuccess(asset, market, analysis, now);
    store.recordInsight(asset, market.marketTime, currentInsight, now);

    assert.equal(store.getAnalysisHistory(asset.symbol).length, 1);
    assert.equal(store.getDashboard().assets[0].aiInsight.summary, "Current insight.");
  });
});

test("records session-horizon predictions, resolves them on later closes, and tallies accuracy", async () => {
  await withStore((store) => {
    const asset = store.listAssets()[0];
    let market = sampleMarket();
    let analysis = analyzePrices(market.prices.map((point) => point.close));
    store.recordSuccess(asset, market, analysis, Date.now());

    for (let session = 1; session <= 20; session += 1) {
      market = {
        ...market,
        prices: [
          ...market.prices,
          {
            timestamp: market.prices.at(-1).timestamp + 86_400,
            close: market.prices.at(-1).close + 0.1,
            volume: 1000 + session
          }
        ]
      };
      analysis = analyzePrices(market.prices.map((point) => point.close));
      store.recordSuccess(asset, market, analysis, Date.now() + session);
    }

    const analytics = store.getPredictionAnalytics(asset.symbol);
    const oneSession = analytics.horizons.find((item) => item.horizonSessions === 1);
    const fiveSessions = analytics.horizons.find((item) => item.horizonSessions === 5);
    const twentySessions = analytics.horizons.find((item) => item.horizonSessions === 20);
    const resolvedPrediction = analytics.recent.find((item) => item.horizonSessions === 1 && item.evaluatedAt);

    assert.equal(oneSession.resolvedCount, 20);
    assert.equal(oneSession.scoredCount, 20);
    assert.equal(oneSession.accuracyPercent, 100);
    assert.equal(oneSession.pendingCount, 1);
    assert.equal(fiveSessions.resolvedCount, 16);
    assert.equal(fiveSessions.accuracyPercent, 100);
    assert.equal(twentySessions.resolvedCount, 1);
    assert.equal(twentySessions.accuracyPercent, 100);
    assert.equal(resolvedPrediction.actualDirection, "UP");
    assert.equal(resolvedPrediction.isCorrect, true);
  });
});

test("retains the last successful reading and publishes provider errors", async () => {
  await withStore((store) => {
    const asset = store.listAssets()[0];
    const market = sampleMarket();
    store.recordSuccess(asset, market, analyzePrices(market.prices.map((point) => point.close)));
    store.recordFailure(asset, new Error("Provider temporarily unavailable."));
    const reading = store.getDashboard().assets[0];

    assert.equal(reading.analysis.signal, "BUY");
    assert.equal(reading.error, "Provider temporarily unavailable.");
  });
});

test("records model errors separately from the rule-based market signal", async () => {
  await withStore((store) => {
    const asset = store.listAssets()[0];
    const market = sampleMarket();
    const analysis = analyzePrices(market.prices.map((point) => point.close));

    store.recordSuccess(asset, market, analysis);
    store.recordInsightFailure(asset, market.marketTime, "llama3:8b", new Error("Ollama is unavailable."));
    const reading = store.getDashboard().assets[0];

    assert.equal(reading.analysis.signal, analysis.signal);
    assert.equal(reading.aiInsight.status, "error");
    assert.equal(reading.aiInsight.error, "Ollama is unavailable.");
  });
});
