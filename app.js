const RANGES = { "1M": 30, "3M": 90, "6M": 180, "1Y": 365 };
const results = new Map();
let trackedIndexes = [];
let indexAssets = [];
let selectedSymbol = "^NSEI";
let selectedRange = "3M";
let isRefreshing = false;
let toastTimeout;

function formatPrice(value, currency = "INR") {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: value < 100 ? 2 : 2
  }).format(value);
}

function formatNumber(value, maximumFractionDigits = 2) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits }).format(value);
}

function formatPercent(value) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function marketChange(prices) {
  if (prices.length < 2) return null;
  const last = prices.at(-1).close;
  const previous = prices.at(-2).close;
  return { amount: last - previous, percent: ((last - previous) / previous) * 100 };
}

function displayDate(timestamp, options = { day: "numeric", month: "short" }) {
  return new Intl.DateTimeFormat("en-IN", { ...options, timeZone: "Asia/Kolkata" }).format(new Date(timestamp * 1000));
}

function showToast(message, isError = false) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("visible"), 3500);
}

function setDataStatus(message, state = "ready") {
  document.querySelector("#data-status").textContent = message;
  const indicator = document.querySelector("#data-indicator");
  indicator.classList.toggle("loading", state === "loading");
  indicator.classList.toggle("error", state === "error");
  const marketStatus = document.querySelector("#market-status");
  marketStatus.textContent = state === "error" ? "Analysis needs attention" : "Indian index data";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function updateFactor(id, label, positive) {
  document.querySelector(`#${id}`).textContent = label;
  const dot = document.querySelector(`#${id}-dot`);
  dot.classList.toggle("positive", positive === true);
  dot.classList.toggle("negative", positive === false);
}

function updateSignal(item) {
  const recommendation = document.querySelector("#recommendation");
  updateAiInsight(item?.aiInsight);
  if (!item?.analysis || !item?.payload) {
    recommendation.className = "recommendation hold";
    document.querySelector("#signal-label").textContent = "Unavailable";
    document.querySelector("#signal-alignment").textContent = "—";
    document.querySelector("#signal-summary").textContent = item?.error ?? "Waiting for price history.";
    ["price", "trend", "rsi", "macd", "long"].forEach((name) => {
      document.querySelector(`#factor-${name}`).textContent = "—";
      document.querySelector(`#factor-${name}-dot`).className = "factor-dot";
    });
    return;
  }

  const { analysis } = item;
  const priceAbove20 = analysis.price > analysis.ema20;
  const trendUp = analysis.ema20 > analysis.ema50;
  const rsiInRange = analysis.rsi >= 50 && analysis.rsi <= 68;
  const macdPositive = analysis.macdHistogram > 0;
  const longTrendUp = analysis.ema200 === null || analysis.price > analysis.ema200;
  const names = { BUY: "Bullish setup", SELL: "Bearish setup", HOLD: "Mixed signals" };
  const explanations = {
    BUY: "Most indicators point higher, but a trend can change without warning.",
    SELL: "Several indicators point lower. Consider downside risk before acting.",
    HOLD: "The indicators disagree. There is no strong directional alignment."
  };
  recommendation.className = `recommendation ${analysis.signal.toLowerCase()}`;
  document.querySelector("#signal-label").textContent = names[analysis.signal];
  document.querySelector("#signal-alignment").textContent = `${analysis.alignedFactors}/${analysis.totalFactors} aligned`;
  document.querySelector("#signal-summary").textContent = explanations[analysis.signal];
  document.querySelector("#signal-icon").textContent = analysis.signal === "SELL" ? "↘" : analysis.signal === "HOLD" ? "↔" : "↗";
  updateFactor("factor-price", priceAbove20 ? "Above EMA 20" : "Below EMA 20", priceAbove20);
  updateFactor("factor-trend", trendUp ? "EMA 20 above EMA 50" : "EMA 20 below EMA 50", trendUp);
  updateFactor("factor-rsi", formatNumber(analysis.rsi, 1), rsiInRange);
  updateFactor("factor-macd", macdPositive ? "Positive" : "Negative", macdPositive);
  updateFactor("factor-long", analysis.ema200 === null ? "Insufficient history" : longTrendUp ? "Above EMA 200" : "Below EMA 200", analysis.ema200 === null ? null : longTrendUp);
}

function renderInsightList(selector, values) {
  const list = document.querySelector(selector);
  list.replaceChildren();
  for (const value of values) {
    const item = document.createElement("li");
    item.textContent = value;
    list.append(item);
  }
}

function updateAiInsight(insight) {
  const status = document.querySelector("#ai-insight-status");
  const summary = document.querySelector("#ai-insight-summary");
  const time = document.querySelector("#ai-insight-time");
  renderInsightList("#ai-drivers", []);
  renderInsightList("#ai-risks", []);

  if (!insight) {
    status.textContent = "Waiting for the local model";
    summary.textContent = "The analyzer will explain the indicator readings after its first run.";
    time.textContent = "LLM commentary is separate from the rule-based signal.";
    return;
  }

  if (insight.status !== "ready") {
    status.textContent = "Local model unavailable";
    summary.textContent = insight.error ?? "The technical signal is available; the AI explanation could not be generated.";
    time.textContent = "Signal calculations do not depend on generative AI.";
    return;
  }

  status.textContent = `Local model · ${insight.model}`;
  summary.textContent = insight.summary;
  time.textContent = `Generated ${new Intl.DateTimeFormat("en-IN", {
    day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata"
  }).format(new Date(insight.generatedAt))} IST`;
  renderInsightList("#ai-drivers", insight.drivers);
  renderInsightList("#ai-risks", insight.risks);
}

function sparkline(prices, positive) {
  const values = prices.slice(-24).map((point) => point.close);
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${26 - ((value - min) / span) * 22}`).join(" ");
  const stroke = positive ? "#45ad7f" : "#d47770";
  return `<svg class="mini-chart" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function renderMarketCards() {
  const container = document.querySelector("#market-cards");
  container.innerHTML = indexAssets.map((index) => {
    const item = results.get(index.symbol);
    if (!item?.payload || !item.analysis) {
      return `<article class="pulse-card"><div class="pulse-card-top"><span class="index-name">${escapeHtml(index.name)}<span class="index-symbol">${escapeHtml(index.symbol)}</span></span></div><div class="index-data"><div><div class="index-skeleton"></div><span class="index-change neutral">${item?.error ? escapeHtml(item.error) : "Awaiting analysis"}</span></div></div></article>`;
    }
    const prices = item.payload.prices;
    const change = marketChange(prices);
    const positive = (change?.percent ?? 0) >= 0;
    return `<article class="pulse-card"><div class="pulse-card-top"><span class="index-name">${escapeHtml(index.name)}<span class="index-symbol">${escapeHtml(index.symbol)}</span></span><span class="index-trend ${positive ? "" : "down"}"><i></i>${item.analysis.signal === "BUY" ? "Bullish" : item.analysis.signal === "SELL" ? "Bearish" : "Neutral"}</span></div><div class="index-data"><div><div class="index-price">${formatNumber(item.analysis.price, 2)}</div><span class="index-change ${positive ? "" : "negative"}">${change ? formatPercent(change.percent) : "—"} today</span></div>${sparkline(prices, positive)}</div></article>`;
  }).join("");
}

function signalPill(signal) {
  const names = { BUY: "BUY", HOLD: "HOLD", SELL: "SELL" };
  return `<span class="signal-pill ${signal.toLowerCase()}"><i class="recommendation-dot"></i>${names[signal]}</span>`;
}

function renderWatchlist() {
  const rows = document.querySelector("#watchlist-rows");
  document.querySelector("#watchlist-count").textContent = trackedIndexes.length;
  document.querySelector("#watchlist-total").textContent = trackedIndexes.length;
  if (trackedIndexes.length === 0) {
    rows.innerHTML = '<tr><td colspan="6"><div class="table-loading">No indexes are configured in the analysis service.</div></td></tr>';
    return;
  }

  rows.innerHTML = trackedIndexes.map((asset) => {
    const item = results.get(asset.symbol);
    if (!item?.payload || !item.analysis) {
      return `<tr data-symbol="${escapeHtml(asset.symbol)}"><td><div class="asset-cell"><span class="table-avatar">${escapeHtml(asset.name[0])}</span><span class="asset-details"><strong>${escapeHtml(asset.name)}</strong><span>${escapeHtml(asset.symbol)} · ${escapeHtml(asset.exchange)}</span></span></div></td><td colspan="4">${item?.error ? `<span class="error-text">${escapeHtml(item.error)}</span>` : '<span class="table-loading"><span class="spinner"></span> Waiting for server analysis…</span>'}</td><td></td></tr>`;
    }
    const change = marketChange(item.payload.prices);
    const changeText = change ? formatPercent(change.percent) : "—";
    const changeClass = !change || change.percent === 0 ? "neutral" : change.percent > 0 ? "" : "negative";
    return `<tr data-symbol="${escapeHtml(asset.symbol)}" aria-label="View ${escapeHtml(asset.name)} analysis"><td><div class="asset-cell"><span class="table-avatar">${escapeHtml(asset.name[0])}</span><span class="asset-details"><strong>${escapeHtml(asset.name)}</strong><span>${escapeHtml(asset.symbol)} · ${escapeHtml(item.payload.exchange)}</span></span></div></td><td class="price-cell">${formatPrice(item.analysis.price, item.payload.currency)}</td><td><span class="change-pill ${changeClass}">${change?.percent > 0 ? "↗" : change?.percent < 0 ? "↘" : "·"} ${changeText}</span></td><td>${signalPill(item.analysis.signal)}</td><td><span class="alignment">${item.analysis.alignedFactors} of ${item.analysis.totalFactors} factors</span></td><td></td></tr>`;
  }).join("");

  rows.querySelectorAll("tr[data-symbol]").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.closest("[data-remove]")) return;
      selectedSymbol = row.dataset.symbol;
      updateSelectedAsset();
    });
  });
}

function renderChart(prices) {
  const canvas = document.querySelector("#price-chart");
  const empty = document.querySelector("#chart-empty");
  const context = canvas.getContext("2d");
  if (!context) return;

  const startDate = Date.now() / 1000 - RANGES[selectedRange] * 24 * 60 * 60;
  const visible = prices.filter((point) => point.timestamp >= startDate);
  if (visible.length < 2) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  const bounds = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(bounds.width * ratio);
  canvas.height = Math.round(bounds.height * ratio);
  context.scale(ratio, ratio);

  const width = bounds.width;
  const height = bounds.height;
  const padding = { top: 12, right: 6, bottom: 20, left: 49 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const values = visible.map((point) => point.close);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min || 1;
  const margin = spread * 0.14;
  const lower = min - margin;
  const upper = max + margin;
  const x = (index) => padding.left + (index / (values.length - 1)) * chartWidth;
  const y = (value) => padding.top + ((upper - value) / (upper - lower)) * chartHeight;

  context.font = '9px "DM Sans", sans-serif';
  context.textAlign = "right";
  context.textBaseline = "middle";
  context.lineWidth = 1;
  for (let tick = 0; tick < 4; tick += 1) {
    const value = upper - ((upper - lower) * tick) / 3;
    const tickY = padding.top + (chartHeight * tick) / 3;
    context.strokeStyle = "#edf1ee";
    context.beginPath();
    context.moveTo(padding.left, tickY);
    context.lineTo(width - padding.right, tickY);
    context.stroke();
    context.fillStyle = "#a0aaa8";
    context.fillText(formatNumber(value, 0), padding.left - 8, tickY);
  }

  const fill = context.createLinearGradient(0, padding.top, 0, height - padding.bottom);
  fill.addColorStop(0, "rgba(62, 169, 120, .19)");
  fill.addColorStop(1, "rgba(62, 169, 120, .01)");
  context.beginPath();
  visible.forEach((point, index) => index === 0 ? context.moveTo(x(index), y(point.close)) : context.lineTo(x(index), y(point.close)));
  context.lineTo(x(visible.length - 1), height - padding.bottom);
  context.lineTo(x(0), height - padding.bottom);
  context.closePath();
  context.fillStyle = fill;
  context.fill();

  context.beginPath();
  visible.forEach((point, index) => index === 0 ? context.moveTo(x(index), y(point.close)) : context.lineTo(x(index), y(point.close)));
  context.strokeStyle = "#39a578";
  context.lineWidth = 2;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.stroke();

  context.textBaseline = "alphabetic";
  context.textAlign = "left";
  context.fillStyle = "#9aa5a2";
  context.fillText(displayDate(visible[0].timestamp), padding.left, height - 3);
  const endLabel = displayDate(visible.at(-1).timestamp);
  context.textAlign = "right";
  context.fillText(endLabel, width - padding.right, height - 3);
  document.querySelector("#chart-start").textContent = displayDate(visible[0].timestamp);
  document.querySelector("#chart-end").textContent = endLabel;
}

function updateSelectedAsset() {
  const item = results.get(selectedSymbol);
  const asset = trackedIndexes.find((entry) => entry.symbol === selectedSymbol) ?? indexAssets.find((entry) => entry.symbol === selectedSymbol);
  if (!asset) return;

  document.querySelector("#selected-name").textContent = item?.payload?.name ?? asset.name;
  document.querySelector("#selected-symbol").textContent = `${selectedSymbol} · ${item?.payload?.exchange ?? asset.exchange}`;
  document.querySelector("#selected-avatar").textContent = asset.name[0];
  document.querySelector("#selected-avatar").style.background = asset.exchange === "BSE" ? "#f6f0eb" : "";
  document.querySelector("#selected-avatar").style.color = asset.exchange === "BSE" ? "#a47650" : "";
  document.querySelector("#chart-price").textContent = item?.analysis ? formatPrice(item.analysis.price, item.payload.currency) : "—";
  const change = item?.payload ? marketChange(item.payload.prices) : null;
  const changeElement = document.querySelector("#chart-change");
  changeElement.textContent = change ? `${formatPercent(change.percent)} today` : item?.error ?? "Daily closing price";
  changeElement.classList.toggle("negative", (change?.percent ?? 0) < 0);
  updateSignal(item);
  renderPredictionAnalytics(item?.predictionAnalytics);
  if (item?.payload) renderChart(item.payload.prices);
  else document.querySelector("#chart-empty").hidden = false;
}

function detectSignalChanges(previousSignals) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  for (const [symbol, item] of results) {
    const previous = previousSignals.get(symbol);
    if (!previous || !item.analysis || previous === item.analysis.signal) continue;
    const asset = trackedIndexes.find((entry) => entry.symbol === symbol) ?? indexAssets.find((entry) => entry.symbol === symbol);
    new Notification(`${asset?.name ?? symbol}: ${item.analysis.signal} setup`, {
      body: `${item.analysis.alignedFactors} of ${item.analysis.totalFactors} trend factors align. This is not a prediction.`,
      tag: `signal-${symbol}`
    });
  }
}

async function refreshData() {
  if (isRefreshing) return;
  isRefreshing = true;
  document.querySelector("#refresh-button").disabled = true;
  setDataStatus("Reading latest analysis…", "loading");
  const previousSignals = new Map([...results].map(([symbol, item]) => [symbol, item.analysis?.signal]));
  try {
    const response = await fetch("/api/trends", { cache: "no-store" });
    const dashboard = await response.json();
    if (!response.ok) throw new Error(dashboard.error ?? `Analysis service returned HTTP ${response.status}.`);

    results.clear();
    dashboard.assets.forEach((asset) => {
      const mappedAsset = { symbol: asset.symbol, name: asset.name, exchange: asset.exchange, kind: asset.kind };
      results.set(asset.symbol, {
        asset: mappedAsset,
        payload: asset.prices.length > 0 ? {
          name: asset.name,
          currency: asset.currency,
          exchange: asset.providerExchange,
          prices: asset.prices,
          marketTime: asset.analysis?.marketTime
        } : null,
        analysis: asset.analysis,
        aiInsight: asset.aiInsight,
        predictionAnalytics: asset.predictionAnalytics,
        error: asset.error ?? (!asset.analysis ? "Waiting for the analysis service to publish its first result." : null)
      });
    });
    trackedIndexes = dashboard.assets.filter((asset) => asset.kind === "index");
    indexAssets = trackedIndexes;
    if (!results.has(selectedSymbol)) selectedSymbol = indexAssets[0]?.symbol ?? trackedIndexes[0]?.symbol;

    renderMarketCards();
    renderWatchlist();
    updateSelectedAsset();
    detectSignalChanges(previousSignals);

    const lastRun = dashboard.analyzer.lastRunAt;
    const updatedAt = lastRun
      ? new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(lastRun))
      : null;
    const analyzerIsStale = lastRun
      ? Date.now() - lastRun > dashboard.refreshIntervalSeconds * 2000
      : dashboard.analyzer.status === "analyzing"
        && dashboard.analyzer.startedAt
        && Date.now() - dashboard.analyzer.startedAt > dashboard.refreshIntervalSeconds * 2000;
    const failedAssets = dashboard.assets.filter((asset) => asset.error).length;
    if (dashboard.analyzer.status === "error") {
      setDataStatus(dashboard.analyzer.error ?? "Analyzer needs attention", "error");
    } else if (analyzerIsStale) {
      setDataStatus(`Last analysis ${updatedAt} · analyzer may be offline`, "error");
    } else if (failedAssets > 0) {
      setDataStatus(`Updated ${updatedAt} IST · ${failedAssets} symbol(s) need attention`, "error");
    } else if (lastRun) {
      setDataStatus(`Server analysis ${updatedAt} IST · every ${Math.round(dashboard.refreshIntervalSeconds / 60)} min`);
    } else {
      setDataStatus(dashboard.analyzer.status === "analyzing" ? "Server is analyzing market data…" : "Waiting for the analysis service", "loading");
    }
  } catch (error) {
    console.error("Unable to read server analysis:", error);
    setDataStatus(error.message, "error");
  } finally {
    document.querySelector("#refresh-button").disabled = false;
    isRefreshing = false;
  }
}

function setRange(range) {
  selectedRange = range;
  document.querySelectorAll(".range-tab").forEach((tab) => {
    const active = tab.dataset.range === range;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", String(active));
  });
  updateSelectedAsset();
}

function renderPredictionAnalytics(analytics) {
  const horizons = document.querySelector("#prediction-horizons");
  const recent = document.querySelector("#prediction-recent");
  const commonMisses = document.querySelector("#prediction-misses");
  if (!analytics) {
    horizons.innerHTML = '<div class="prediction-empty">Outcome tracking is not available for this symbol.</div>';
    recent.replaceChildren();
    commonMisses.replaceChildren();
    return;
  }

  horizons.innerHTML = analytics.horizons.map((horizon) => {
    const accuracy = horizon.accuracyPercent === null
      ? "Not enough results"
      : `${horizon.accuracyPercent.toFixed(1)}%${horizon.scoredCount < 30 ? "*" : ""}`;
    const denominator = horizon.scoredCount ? `${horizon.correctCount} / ${horizon.scoredCount} correct` : "0 scored calls";
    const averageReturn = horizon.averageAlignedReturnPercent === null ? "—" : formatPercent(horizon.averageAlignedReturnPercent);
    return `<article class="horizon-card"><span class="horizon-name">${horizon.horizonSessions} ${horizon.horizonSessions === 1 ? "session" : "sessions"}</span><strong>${accuracy}</strong><span class="horizon-detail">${denominator} · ${horizon.pendingCount} pending</span><span class="horizon-detail">${horizon.holdCount} HOLD · ${horizon.flatCount} flat excluded</span><span class="horizon-detail">Average signal-aligned close return: ${averageReturn}</span></article>`;
  }).join("");

  renderInsightList("#prediction-misses", analytics.horizons
    .flatMap((horizon) => horizon.commonMissFactors.map((item) => ({
      horizonSessions: horizon.horizonSessions,
      ...item
    })))
    .sort((left, right) => right.count - left.count)
    .slice(0, 4)
    .map((item) => `${item.count} miss(es), ${item.horizonSessions}-session horizon: ${item.reason}`));

  recent.replaceChildren();
  for (const prediction of analytics.recent.slice(0, 6)) {
    const row = document.createElement("li");
    const actual = prediction.isCorrect === null
      ? prediction.evaluatedAt ? "Not direction-scored" : "Pending"
      : prediction.isCorrect ? "Correct direction" : "Wrong direction";
    const details = document.createElement("span");
    details.textContent = `${displayDate(prediction.entryTimestamp, { day: "numeric", month: "short", year: "2-digit" })} · ${prediction.signal} · ${prediction.horizonSessions}-session result`;
    const outcome = document.createElement("strong");
    outcome.textContent = prediction.actualReturnPercent === null
      ? actual
      : `${actual} · ${formatPercent(prediction.actualReturnPercent)} actual`;
    outcome.className = prediction.isCorrect === false ? "prediction-wrong" : prediction.isCorrect === true ? "prediction-correct" : "";
    row.append(details, outcome);
    recent.append(row);
  }

  if (analytics.recent.length === 0) {
    recent.innerHTML = '<li class="prediction-empty">No prediction snapshots yet. They will appear after the analysis service runs.</li>';
  }
}

async function toggleAlerts() {
  if (!("Notification" in window)) {
    showToast("Browser notifications are not supported here.", true);
    return;
  }
  if (Notification.permission === "denied") {
    showToast("Notifications are blocked. Allow them in your browser site settings.", true);
    return;
  }
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission === "granted") {
    document.querySelector("#alerts-button").classList.add("enabled");
    showToast("Signal-change alerts are on. Keep this tab open to receive them.");
  } else {
    showToast("Browser notification permission was not granted.", true);
  }
}

function initialize() {
  document.querySelector("#today-date").textContent = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(new Date()).toUpperCase();
  document.querySelector("#refresh-button").addEventListener("click", refreshData);
  document.querySelector("#alerts-button").addEventListener("click", toggleAlerts);
  document.querySelectorAll(".range-tab").forEach((tab) => tab.addEventListener("click", () => setRange(tab.dataset.range)));
  document.querySelectorAll(".nav-link[href^='#']").forEach((link) => link.addEventListener("click", () => {
    document.querySelectorAll(".nav-link").forEach((item) => {
      item.classList.toggle("active", item === link);
      if (item === link) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
  }));
  window.addEventListener("resize", () => {
    const item = results.get(selectedSymbol);
    if (item?.payload) renderChart(item.payload.prices);
  });
  if ("Notification" in window && Notification.permission === "granted") {
    document.querySelector("#alerts-button").classList.add("enabled");
  }
  renderWatchlist();
  refreshData();
  setInterval(refreshData, 60_000);
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("/service-worker.js").catch((error) => {
      console.error("Unable to register offline support:", error);
    });
  }
}

initialize();
