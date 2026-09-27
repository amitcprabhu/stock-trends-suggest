function ema(values, period) {
  const result = Array(values.length).fill(null);
  if (values.length === 0) return result;

  const multiplier = 2 / (period + 1);
  let previous = values[0];
  result[0] = previous;

  for (let i = 1; i < values.length; i += 1) {
    previous = (values[i] - previous) * multiplier + previous;
    result[i] = previous;
  }
  return result;
}

function rsi(values, period = 14) {
  const result = Array(values.length).fill(null);
  if (values.length <= period) return result;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i] - values[i - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;
  result[period] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);

  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[i] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }
  return result;
}

function macd(values) {
  const fast = ema(values, 12);
  const slow = ema(values, 26);
  const line = values.map((_, i) => fast[i] - slow[i]);
  const signal = ema(line, 9);
  return line.map((value, i) => value - signal[i]);
}

export function analyzePrices(closes) {
  if (!Array.isArray(closes) || closes.length < 35 || closes.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new RangeError("At least 35 positive closing prices are required for a trend analysis.");
  }

  const latest = closes.length - 1;
  const ema20 = ema(closes, 20)[latest];
  const ema50 = ema(closes, 50)[latest];
  const ema200 = closes.length >= 200 ? ema(closes, 200)[latest] : null;
  const latestRsi = rsi(closes)[latest];
  const macdHistogram = macd(closes)[latest];
  const factors = [
    closes[latest] > ema20,
    ema20 > ema50,
    latestRsi >= 50 && latestRsi <= 68,
    macdHistogram > 0,
    ema200 === null ? null : closes[latest] > ema200
  ];
  const applicableFactors = factors.filter((factor) => factor !== null);
  const alignedFactors = applicableFactors.filter(Boolean).length;

  return {
    price: closes[latest],
    ema20,
    ema50,
    ema200,
    rsi: latestRsi,
    macdHistogram,
    alignedFactors,
    totalFactors: applicableFactors.length,
    signal: alignedFactors >= applicableFactors.length * 0.8
      ? "BUY"
      : alignedFactors <= applicableFactors.length * 0.2
        ? "SELL"
        : "HOLD"
  };
}
