import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_ASSETS } from "./assets.mjs";
import { captureFactors, evaluatePrediction, PREDICTION_HORIZONS } from "./prediction.mjs";

const HISTORY_DAYS = 90;
const PRICE_HISTORY_DAYS = 370;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function createStore(databasePath = process.env.DATABASE_PATH ?? "data/trends.sqlite", configuredAssets = DEFAULT_ASSETS) {
  const resolvedPath = resolve(databasePath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  const db = new DatabaseSync(resolvedPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS assets (
      symbol TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      exchange TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('stock', 'index')),
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS price_points (
      symbol TEXT NOT NULL REFERENCES assets(symbol) ON DELETE CASCADE,
      timestamp INTEGER NOT NULL,
      close REAL NOT NULL CHECK (close > 0),
      volume REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL,
      exchange TEXT NOT NULL,
      PRIMARY KEY (symbol, timestamp)
    );
    CREATE INDEX IF NOT EXISTS price_points_timestamp_idx ON price_points(timestamp);
    CREATE TABLE IF NOT EXISTS analyses (
      symbol TEXT NOT NULL REFERENCES assets(symbol) ON DELETE CASCADE,
      analyzed_at INTEGER NOT NULL,
      market_time INTEGER,
      price REAL NOT NULL CHECK (price > 0),
      currency TEXT NOT NULL,
      exchange TEXT NOT NULL,
      signal TEXT NOT NULL CHECK (signal IN ('BUY', 'HOLD', 'SELL')),
      aligned_factors INTEGER NOT NULL,
      total_factors INTEGER NOT NULL,
      ema20 REAL NOT NULL,
      ema50 REAL NOT NULL,
      ema200 REAL,
      rsi REAL NOT NULL,
      macd_histogram REAL NOT NULL,
      PRIMARY KEY (symbol, analyzed_at)
    );
    CREATE INDEX IF NOT EXISTS analyses_recent_idx ON analyses(symbol, analyzed_at DESC);
    CREATE TABLE IF NOT EXISTS predictions (
      prediction_id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL REFERENCES assets(symbol) ON DELETE CASCADE,
      entry_timestamp INTEGER NOT NULL,
      horizon_sessions INTEGER NOT NULL CHECK (horizon_sessions IN (1, 5, 20)),
      signal TEXT NOT NULL CHECK (signal IN ('BUY', 'HOLD', 'SELL')),
      entry_price REAL NOT NULL CHECK (entry_price > 0),
      factors_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      target_timestamp INTEGER,
      target_price REAL,
      actual_return_percent REAL,
      actual_direction TEXT CHECK (actual_direction IN ('UP', 'DOWN', 'FLAT')),
      is_correct INTEGER CHECK (is_correct IN (0, 1) OR is_correct IS NULL),
      max_adverse_close_move_percent REAL,
      diagnostics_json TEXT NOT NULL DEFAULT '[]',
      evaluated_at INTEGER,
      UNIQUE (symbol, entry_timestamp, horizon_sessions)
    );
    CREATE INDEX IF NOT EXISTS predictions_pending_idx ON predictions(symbol, entry_timestamp) WHERE evaluated_at IS NULL;
    CREATE INDEX IF NOT EXISTS predictions_recent_idx ON predictions(symbol, entry_timestamp DESC);
    CREATE TABLE IF NOT EXISTS analyzer_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL,
      started_at INTEGER,
      last_run_at INTEGER,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS analyzer_errors (
      symbol TEXT PRIMARY KEY REFERENCES assets(symbol) ON DELETE CASCADE,
      error TEXT NOT NULL,
      attempted_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_insights (
      symbol TEXT NOT NULL REFERENCES assets(symbol) ON DELETE CASCADE,
      market_time INTEGER NOT NULL,
      generated_at INTEGER NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ready', 'error')),
      summary TEXT,
      drivers_json TEXT NOT NULL DEFAULT '[]',
      risks_json TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      PRIMARY KEY (symbol, market_time)
    );
    CREATE INDEX IF NOT EXISTS ai_insights_recent_idx ON ai_insights(symbol, generated_at DESC);
    INSERT OR IGNORE INTO analyzer_state (id, status) VALUES (1, 'waiting');
  `);

  const addAsset = db.prepare(`
    INSERT INTO assets (symbol, name, exchange, kind, sort_order)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(symbol) DO UPDATE SET
      name = excluded.name,
      exchange = excluded.exchange,
      kind = excluded.kind,
      sort_order = excluded.sort_order
  `);
  configuredAssets.forEach((asset, index) => addAsset.run(asset.symbol, asset.name, asset.exchange, asset.kind, index));

  const insertPrice = db.prepare(`
    INSERT INTO price_points (symbol, timestamp, close, volume, currency, exchange)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, timestamp) DO UPDATE SET
      close = excluded.close,
      volume = excluded.volume,
      currency = excluded.currency,
      exchange = excluded.exchange
  `);
  const insertAnalysis = db.prepare(`
    INSERT INTO analyses (
      symbol, analyzed_at, market_time, price, currency, exchange, signal,
      aligned_factors, total_factors, ema20, ema50, ema200, rsi, macd_histogram
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPrediction = db.prepare(`
    INSERT INTO predictions (
      symbol, entry_timestamp, horizon_sessions, signal, entry_price, factors_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, entry_timestamp, horizon_sessions) DO NOTHING
  `);
  const getPendingPredictions = db.prepare("SELECT * FROM predictions WHERE symbol = ? AND evaluated_at IS NULL");
  const getFuturePrices = db.prepare(`
    SELECT timestamp, close FROM price_points
    WHERE symbol = ? AND timestamp > ? ORDER BY timestamp LIMIT ?
  `);
  const savePredictionOutcome = db.prepare(`
    UPDATE predictions SET
      target_timestamp = ?,
      target_price = ?,
      actual_return_percent = ?,
      actual_direction = ?,
      is_correct = ?,
      max_adverse_close_move_percent = ?,
      diagnostics_json = ?,
      evaluated_at = ?
    WHERE prediction_id = ? AND evaluated_at IS NULL
  `);
  const updateAnalyzerState = db.prepare(`
    UPDATE analyzer_state SET status = ?, started_at = ?, last_run_at = ?, last_error = ? WHERE id = 1
  `);
  const updateLastRun = db.prepare("UPDATE analyzer_state SET last_run_at = ? WHERE id = 1");
  const upsertError = db.prepare(`
    INSERT INTO analyzer_errors (symbol, error, attempted_at)
    VALUES (?, ?, ?)
    ON CONFLICT(symbol) DO UPDATE SET error = excluded.error, attempted_at = excluded.attempted_at
  `);
  const saveInsight = db.prepare(`
    INSERT INTO ai_insights (
      symbol, market_time, generated_at, model, status, summary, drivers_json, risks_json, error
    ) VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, NULL)
    ON CONFLICT(symbol, market_time) DO UPDATE SET
      generated_at = excluded.generated_at,
      model = excluded.model,
      status = 'ready',
      summary = excluded.summary,
      drivers_json = excluded.drivers_json,
      risks_json = excluded.risks_json,
      error = NULL
  `);
  const saveInsightError = db.prepare(`
    INSERT INTO ai_insights (
      symbol, market_time, generated_at, model, status, summary, drivers_json, risks_json, error
    ) VALUES (?, ?, ?, ?, 'error', NULL, '[]', '[]', ?)
    ON CONFLICT(symbol, market_time) DO UPDATE SET
      generated_at = excluded.generated_at,
      model = excluded.model,
      status = 'error',
      error = excluded.error
  `);

  const clearError = db.prepare("DELETE FROM analyzer_errors WHERE symbol = ?");
  const getAssets = db.prepare("SELECT symbol, name, exchange, kind FROM assets ORDER BY sort_order, symbol");
  const getIndexAssets = db.prepare("SELECT symbol, name, exchange, kind FROM assets WHERE kind = 'index' ORDER BY sort_order, symbol");
  const getAsset = db.prepare("SELECT symbol, kind FROM assets WHERE symbol = ?");
  const getLatestAnalysis = db.prepare(`
    SELECT * FROM analyses WHERE symbol = ? ORDER BY analyzed_at DESC LIMIT 1
  `);
  const getPrices = db.prepare(`
    SELECT timestamp, close, volume, currency, exchange FROM price_points
    WHERE symbol = ? ORDER BY timestamp DESC LIMIT 260
  `);
  const getError = db.prepare("SELECT error, attempted_at FROM analyzer_errors WHERE symbol = ?");
  const getLatestInsight = db.prepare("SELECT * FROM ai_insights WHERE symbol = ? ORDER BY generated_at DESC LIMIT 1");
  const getPredictionHistory = db.prepare(`
    SELECT * FROM predictions
    WHERE symbol = ? AND entry_timestamp >= ?
    ORDER BY entry_timestamp DESC, horizon_sessions ASC
  `);
  const getState = db.prepare("SELECT * FROM analyzer_state WHERE id = 1");
  return {
    path: resolvedPath,
    listAssets() {
      return getIndexAssets.all();
    },
    recordSuccess(asset, market, analysis, analyzedAt = Date.now()) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const point of market.prices) {
          insertPrice.run(asset.symbol, point.timestamp, point.close, point.volume, market.currency, market.exchange);
        }
        insertAnalysis.run(
          asset.symbol, analyzedAt, market.marketTime, analysis.price, market.currency, market.exchange,
          analysis.signal, analysis.alignedFactors, analysis.totalFactors, analysis.ema20, analysis.ema50,
          analysis.ema200, analysis.rsi, analysis.macdHistogram
        );
        const latestPrice = market.prices.at(-1);
        if (!latestPrice) throw new Error(`Market provider returned no daily prices for ${asset.symbol}.`);
        const factors = JSON.stringify(captureFactors(analysis));
        for (const horizonSessions of PREDICTION_HORIZONS) {
          insertPrediction.run(
            asset.symbol, latestPrice.timestamp, horizonSessions, analysis.signal,
            analysis.price, factors, analyzedAt
          );
        }
        for (const prediction of getPendingPredictions.all(asset.symbol)) {
          const futurePrices = getFuturePrices.all(
            asset.symbol, prediction.entry_timestamp, prediction.horizon_sessions
          );
          const outcome = evaluatePrediction({
            symbol: prediction.symbol,
            signal: prediction.signal,
            entryPrice: prediction.entry_price,
            horizonSessions: prediction.horizon_sessions,
            factors: prediction.factors_json
          }, futurePrices);
          if (!outcome) continue;
          savePredictionOutcome.run(
            outcome.targetTimestamp, outcome.targetPrice, outcome.actualReturnPercent,
            outcome.actualDirection, outcome.isCorrect === null ? null : Number(outcome.isCorrect),
            outcome.maxAdverseCloseMovePercent, JSON.stringify(outcome.diagnostics),
            analyzedAt, prediction.prediction_id
          );
        }
        clearError.run(asset.symbol);
        const cutoff = analyzedAt - HISTORY_DAYS * DAY_MS;
        db.prepare("DELETE FROM analyses WHERE analyzed_at < ?").run(cutoff);
        db.prepare("DELETE FROM predictions WHERE created_at < ?").run(cutoff);
        db.prepare("DELETE FROM price_points WHERE timestamp < ?").run(Math.floor((analyzedAt - PRICE_HISTORY_DAYS * DAY_MS) / 1000));
        updateLastRun.run(analyzedAt);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    recordFailure(asset, error, attemptedAt = Date.now()) {
      upsertError.run(asset.symbol, error.message, attemptedAt);
    },
    setAnalyzerState(status, { startedAt = null, lastRunAt = null, error = null } = {}) {
      updateAnalyzerState.run(status, startedAt, lastRunAt, error);
    },
    getDashboard() {
      const state = getState.get();
      const assets = getIndexAssets.all().map((asset) => {
        const analysis = getLatestAnalysis.get(asset.symbol);
        const prices = getPrices.all(asset.symbol).reverse().map((point) => ({
          timestamp: point.timestamp,
          close: point.close,
          volume: point.volume,
          currency: point.currency,
          exchange: point.exchange
        }));
        const error = getError.get(asset.symbol);
        const insight = getLatestInsight.get(asset.symbol);
        return {
          ...asset,
          currency: analysis?.currency ?? prices.at(-1)?.currency ?? "INR",
          providerExchange: analysis?.exchange ?? prices.at(-1)?.exchange ?? asset.exchange,
          prices,
          analysis: analysis ? {
            analyzedAt: analysis.analyzed_at,
            marketTime: analysis.market_time,
            price: analysis.price,
            signal: analysis.signal,
            alignedFactors: analysis.aligned_factors,
            totalFactors: analysis.total_factors,
            ema20: analysis.ema20,
            ema50: analysis.ema50,
            ema200: analysis.ema200,
            rsi: analysis.rsi,
            macdHistogram: analysis.macd_histogram
          } : null,
          error: error?.error ?? null,
          attemptedAt: error?.attempted_at ?? null,
          predictionAnalytics: getPredictionAnalytics(asset.symbol),
          aiInsight: insight ? {
            marketTime: insight.market_time,
            generatedAt: insight.generated_at,
            model: insight.model,
            status: insight.status,
            summary: insight.summary,
            drivers: JSON.parse(insight.drivers_json),
            risks: JSON.parse(insight.risks_json),
            error: insight.error
          } : null
        };
      });
      return {
        generatedAt: state.last_run_at,
        analyzer: {
          status: state.status,
          startedAt: state.started_at,
          lastRunAt: state.last_run_at,
          error: state.last_error
        },
        refreshIntervalSeconds: Number(process.env.ANALYSIS_INTERVAL_MS ?? 300_000) / 1000,
        historyDays: HISTORY_DAYS,
        assets
      };
    },
    getPredictionAnalytics,
    getLatestInsight(symbol) {
      const row = getLatestInsight.get(symbol);
      return row ? {
        marketTime: row.market_time,
        status: row.status,
        model: row.model
      } : null;
    },
    recordInsight(asset, marketTime, insight, generatedAt = Date.now()) {
      saveInsight.run(
        asset.symbol, marketTime, generatedAt, insight.model, insight.summary,
        JSON.stringify(insight.drivers), JSON.stringify(insight.risks)
      );
      db.prepare("DELETE FROM ai_insights WHERE generated_at < ?").run(generatedAt - HISTORY_DAYS * DAY_MS);
    },
    recordInsightFailure(asset, marketTime, model, error, generatedAt = Date.now()) {
      saveInsightError.run(asset.symbol, marketTime, generatedAt, model, error.message);
      db.prepare("DELETE FROM ai_insights WHERE generated_at < ?").run(generatedAt - HISTORY_DAYS * DAY_MS);
    },
    getAnalysisHistory(symbol, now = Date.now()) {
      const asset = getAsset.get(symbol);
      if (asset?.kind !== "index") return null;
      const history = db.prepare(`
        SELECT analyzed_at, price, signal, aligned_factors, total_factors
        FROM analyses WHERE symbol = ? ORDER BY analyzed_at
      `).all(String(symbol));
      return history.filter((row) => row.analyzed_at >= now - HISTORY_DAYS * DAY_MS).map((row) => ({
        analyzedAt: row.analyzed_at,
        price: row.price,
        signal: row.signal,
        alignedFactors: row.aligned_factors,
        totalFactors: row.total_factors
      }));
    },
    close() {
      db.close();
    }
  };

  function getPredictionAnalytics(symbol, now = Date.now()) {
    if (getAsset.get(symbol)?.kind !== "index") return null;
    const cutoff = Math.floor((now - HISTORY_DAYS * DAY_MS) / 1000);
    const rows = getPredictionHistory.all(symbol, cutoff);
    const horizons = PREDICTION_HORIZONS.map((horizonSessions) => {
      const records = rows.filter((row) => row.horizon_sessions === horizonSessions);
      const resolved = records.filter((row) => row.evaluated_at !== null);
      const scored = resolved.filter((row) => row.signal !== "HOLD" && row.actual_direction !== "FLAT");
      const correct = scored.filter((row) => row.is_correct === 1);
      const holds = resolved.filter((row) => row.signal === "HOLD");
      const missedFactors = new Map();
      for (const record of scored.filter((row) => row.is_correct === 0)) {
        let reasons;
        try {
          reasons = JSON.parse(record.diagnostics_json);
        } catch {
          reasons = [];
        }
        for (const reason of reasons) missedFactors.set(reason, (missedFactors.get(reason) ?? 0) + 1);
      }

      const alignedReturns = scored.map((row) => (row.signal === "BUY" ? 1 : -1) * row.actual_return_percent);
      return {
        horizonSessions,
        predictionCount: records.length,
        resolvedCount: resolved.length,
        pendingCount: records.length - resolved.length,
        scoredCount: scored.length,
        correctCount: correct.length,
        wrongCount: scored.length - correct.length,
        flatCount: resolved.filter((row) => row.signal !== "HOLD" && row.actual_direction === "FLAT").length,
        holdCount: holds.length,
        accuracyPercent: scored.length === 0 ? null : (correct.length / scored.length) * 100,
        averageAlignedReturnPercent: alignedReturns.length === 0
          ? null
          : alignedReturns.reduce((sum, value) => sum + value, 0) / alignedReturns.length,
        commonMissFactors: [...missedFactors.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((left, right) => right.count - left.count)
          .slice(0, 3)
      };
    });

    const recent = rows.slice(0, 12).map((row) => ({
      symbol: row.symbol,
      entryTimestamp: row.entry_timestamp,
      horizonSessions: row.horizon_sessions,
      signal: row.signal,
      entryPrice: row.entry_price,
      targetTimestamp: row.target_timestamp,
      targetPrice: row.target_price,
      actualReturnPercent: row.actual_return_percent,
      actualDirection: row.actual_direction,
      isCorrect: row.is_correct === null ? null : row.is_correct === 1,
      maxAdverseCloseMovePercent: row.max_adverse_close_move_percent,
      evaluatedAt: row.evaluated_at,
      diagnostics: JSON.parse(row.diagnostics_json)
    }));
    return { windowDays: HISTORY_DAYS, horizons, recent };
  }
}
