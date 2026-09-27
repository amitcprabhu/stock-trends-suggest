import { generateInsight } from "./ai-insights.mjs";
import { analyzePrices } from "./analysis.mjs";
import { createStore } from "./database.mjs";
import { fetchDailyPrices } from "./market-data.mjs";

const intervalMs = Number(process.env.ANALYSIS_INTERVAL_MS ?? 300_000);
const aiEnabled = process.env.AI_ENABLED !== "false";
const aiModel = process.env.OLLAMA_MODEL ?? "llama3:8b";
if (!Number.isInteger(intervalMs) || intervalMs < 30_000) {
  throw new RangeError("ANALYSIS_INTERVAL_MS must be an integer of at least 30000 milliseconds.");
}

const store = await createStore();
let stopping = false;
let running = false;
let lastRunAt = store.getDashboard().analyzer.lastRunAt;

async function analyzeCycle() {
  if (running || stopping) return null;
  running = true;
  const startedAt = Date.now();
  const assets = store.listAssets().filter((asset) => asset.kind === "index");
  let failures = 0;
  try {
    store.setAnalyzerState("analyzing", { startedAt, lastRunAt });
    console.log(`Starting market analysis at ${new Date(startedAt).toISOString()}.`);

    for (const asset of assets) {
      if (stopping) break;
      try {
        const market = await fetchDailyPrices(asset.symbol);
        const analysis = analyzePrices(market.prices.map((point) => point.close));
        store.recordSuccess(asset, market, analysis);
        console.log(`${asset.symbol}: ${analysis.signal} (${analysis.alignedFactors}/${analysis.totalFactors} factors).`);
        if (aiEnabled) {
          const marketTime = market.prices.at(-1).timestamp;
          const existingInsight = store.getLatestInsight(asset.symbol);
          if (existingInsight?.marketTime === marketTime && existingInsight.status === "ready") {
            console.log(`${asset.symbol}: local AI explanation is already current.`);
          } else {
            try {
              const insight = await generateInsight({ asset, market, analysis });
              store.recordInsight(asset, marketTime, insight);
              console.log(`${asset.symbol}: local AI explanation saved (${insight.model}).`);
            } catch (error) {
              store.recordInsightFailure(asset, marketTime, aiModel, error);
              console.error(`${asset.symbol}: local AI explanation unavailable: ${error.message}`);
            }
          }
        }
      } catch (error) {
        failures += 1;
        store.recordFailure(asset, error);
        console.error(`Unable to analyze ${asset.symbol}: ${error.message}`);
      }
    }

    lastRunAt = Date.now();
    store.setAnalyzerState(failures === assets.length ? "error" : "ready", {
      lastRunAt,
      error: failures === assets.length ? "Market data could not be loaded for any configured asset." : null
    });
    console.log(`Analysis finished with ${failures} failed asset(s).`);
    return { failures, total: assets.length };
  } catch (error) {
    store.setAnalyzerState("error", { lastRunAt, error: error.message });
    throw error;
  } finally {
    running = false;
  }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log("Stopping market analyzer.");
  while (running) await new Promise((resolve) => setTimeout(resolve, 100));
  store.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  const result = await analyzeCycle();
  if (process.argv.includes("--once")) {
    store.close();
    if (result?.total > 0 && result.failures === result.total) process.exitCode = 1;
  } else {
    setInterval(() => {
      analyzeCycle().catch((error) => {
        console.error("Market analysis cycle failed:", error);
        store.setAnalyzerState("error", { lastRunAt, error: error.message });
      });
    }, intervalMs);
    console.log(`Next cycle in ${Math.round(intervalMs / 1000)} seconds. Database: ${store.path}`);
  }
} catch (error) {
  store.setAnalyzerState("error", { lastRunAt, error: error.message });
  store.close();
  console.error("Market analyzer could not start:", error);
  process.exitCode = 1;
}
