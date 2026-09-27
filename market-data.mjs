export async function fetchDailyPrices(symbol) {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("range", "1y");
  url.searchParams.set("interval", "1d");
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 stock-trends-suggest/1.0" },
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`Market data provider returned HTTP ${response.status}.`);

  const body = await response.json();
  const result = body.chart?.result?.[0];
  if (body.chart?.error || !result) {
    throw new Error(body.chart?.error?.description ?? "The market data provider returned no chart data.");
  }

  const closes = result.indicators?.quote?.[0]?.close;
  if (!Array.isArray(result.timestamp) || !Array.isArray(closes)) {
    throw new Error("The market data provider returned an incomplete price history.");
  }

  const volumes = result.indicators?.quote?.[0]?.volume ?? [];
  const prices = result.timestamp.flatMap((timestamp, index) => {
    const close = closes[index];
    return Number.isFinite(close)
      ? [{ timestamp, close, volume: Number.isFinite(volumes[index]) ? volumes[index] : 0 }]
      : [];
  });
  if (prices.length < 35) throw new Error("The provider returned fewer than 35 usable daily prices.");

  return {
    symbol: result.meta.symbol,
    name: result.meta.shortName ?? result.meta.longName ?? result.meta.symbol,
    currency: result.meta.currency ?? "INR",
    exchange: result.meta.fullExchangeName ?? result.meta.exchangeName ?? "Market",
    marketTime: result.meta.regularMarketTime ?? null,
    prices
  };
}
