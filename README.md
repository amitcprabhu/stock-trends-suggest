# TrendSignal

TrendSignal is split into two processes that share a local SQLite database. The current prediction experiment intentionally tracks **indexes only**—NIFTY 50, SENSEX, and BANK NIFTY—so the early scorecard compares a small, consistent market universe.

1. **Market analyzer** fetches free daily price history, calculates trend indicators and saves readings.
2. **Mobile dashboard** reads the saved data from a read-only JSON API. It is a responsive, installable PWA and never contacts the market-data provider directly.

## Requirements

- Node.js 22.5 or newer. The built-in `node:sqlite` module is used; no third-party packages are needed.
- Internet access on the analyzer machine for Yahoo Finance daily prices.
- [Ollama](https://ollama.com/) on the analyzer machine for local AI explanations. Install it and fetch the default model once:

```sh
ollama pull llama3:8b
```

- For the mobile dashboard to be installable as a PWA on a phone, serve it over HTTPS. Plain HTTP works for local development, but browsers require HTTPS for service workers outside `localhost`.

## Run the two applications

Start these in separate terminals from the project directory.

**Terminal 1 — web server and mobile dashboard:**

```sh
npm run web
```

The server listens on port `3000` and binds to `0.0.0.0` so other devices on your local network can read the dashboard. Open `http://localhost:3000` on the server machine. From a phone on the same Wi-Fi, use the server computer's LAN IP, for example `http://192.168.1.20:3000`. Allow inbound connections to port 3000 in the computer's firewall if needed.

**Terminal 2 — market analyzer:**

```sh
npm run analyze
```

The analyzer performs a run immediately, then repeats every five minutes. It fetches the three configured indexes one at a time and asks Ollama for a short explanation only when an index's daily market timestamp changes. Keep this process running; if it stops, the mobile app continues showing the last saved results and indicates when they become stale. Ollama must be running locally at `http://127.0.0.1:11434`.

Run one analysis cycle and exit:

```sh
npm run analyze:once
```

`npm start` starts the **web server only**. Run `npm run analyze` in another terminal to keep readings up to date. Set a different port in PowerShell if port 3000 is already in use: `$env:PORT=3001; npm run web`.

When deploying beyond your trusted local network, put the web server behind an HTTPS reverse proxy. The mobile API is read-only, but this MVP does not implement user authentication.

## Shared database and API

Both processes use the same SQLite file at `data/trends.sqlite`. The analyzer writes market history and indicator snapshots; the web server reads them to serve:

- `GET /api/trends` — configured instruments, recent prices, latest analysis, prediction scorecards and analyzer status.
- `GET /api/trends/history?symbol=%5ENSEI` — the selected instrument's rolling 90-day analysis history.
- `GET /api/predictions?symbol=%5ENSEI` — prediction snapshots, their forward outcomes and directional scorecards.

Set `DATABASE_PATH` to use a different database file. The generated database and its SQLite journal files stay local and are excluded from Git.

Analysis snapshots, AI explanations, and prediction records are kept for **90 days**; older entries are automatically removed during a successful data save. Daily price history is kept for **370 days** to support the one-year chart, 200-day EMA, and forward prediction scoring. The dashboard polls the API every minute; it does not trigger another market-data download or AI generation.

Edit `assets.mjs` to change the shared server-side index list. Use Yahoo Finance index symbols (for example, `^NSEI`, `^BSESN`, and `^NSEBANK`). The analyzer and mobile dashboard only process and display configured indexes. Legacy stock records from earlier app versions remain in SQLite, but are no longer analyzed or shown; switching the target universe does not delete those stored records. Restart the processes to apply a configuration change. Since the index list is server-managed, indexes cannot be added or removed from the read-only mobile dashboard.

## Signals and data

The analyzer uses Yahoo Finance's chart endpoint for daily closing prices. Provider availability, licensing, timing and delay are outside this app's control; prices may be delayed, missing or unavailable. No intraday quote or real-time execution data is provided.

The rules-based setup uses the latest close relative to its 20-day and 200-day exponential moving averages (EMA), the 20-day relative to the 50-day EMA, 14-day relative strength index (RSI), and MACD histogram. The long-term EMA factor is omitted until enough history is available. A setup is labelled **BUY** when at least 80% of applicable factors are positive, **SELL** when at most 20% are positive, and **HOLD** otherwise. Indicator alignment is a count of conditions, not a probability or expected return. These educational trend summaries are not financial advice or trade instructions.

## Measuring prediction direction

For each configured index, the analyzer writes one immutable BUY/HOLD/SELL prediction for each new provider daily closing timestamp and records the entry close and EMA/RSI/MACD conditions used to make it. It tracks **1-, 5-, and 20-trading-session** horizons. As later daily closes arrive, it saves the horizon's final close, actual percent change and direction, maximum adverse daily-close move, and specific indicator conditions that were already present at entry.

The prediction scorecard reports directional accuracy as correct non-HOLD calls divided by resolved, non-HOLD BUY/SELL calls. HOLD signals and exactly unchanged outcomes are shown separately rather than counted as correct or incorrect; unfinished horizons remain pending. The scorecard also shows aligned returns and recurring, rule-derived indicator mismatches in missed calls.

These are retrospective close-to-close comparisons—not backtests of achievable trades, measures of profitability, or guarantees. They do not account for fees, spreads, slippage, intraday movements, survivorship or benchmark-relative performance. Indicator mismatch notes report conditions visible at the time, **not proven causes** of a miss. Expect too few observations for meaningful accuracy early on; compare fixed horizons and market regimes before adjusting signal thresholds.

## Local generative AI

The analyzer sends only the symbol, daily closing-price changes, existing deterministic signal and technical indicator values to the local Ollama service. The model adds a short explanation, notable factors and risks to the dashboard. It does **not** fetch market prices or news, override the signal, make forecasts, or place orders. AI failures are stored separately and do not interrupt technical analysis. Its explanations can still be wrong; compare them with the displayed indicator readings.

The default model is `llama3:8b`. Set `OLLAMA_MODEL` to a model you have installed and `OLLAMA_URL` to the local Ollama API base if needed. Set `AI_ENABLED=false` to run just the technical analysis. The analyzer retries AI explanations that have failed, but avoids asking the model again when a successful explanation already exists for that daily market timestamp.

The free Yahoo chart endpoint provides **daily data**, not a licensed real-time feed. The provider adapter is isolated in `market-data.mjs`; adding a genuine live feed requires a provider or broker API that explicitly grants live-market access. Streaming data would need minute-candle aggregation and a higher-frequency analysis pipeline before AI summaries can become correspondingly current. An LLM cannot make delayed input real-time.

The service worker caches the dashboard shell and the latest trends response for offline viewing. Offline readings may be stale. Browser notifications compare new readings while the dashboard is open; they are not push notifications and will not wake a closed app.

## Tests

```sh
npm test
```
