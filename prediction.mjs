export const PREDICTION_HORIZONS = [1, 5, 20];

export function captureFactors(analysis) {
  return {
    priceAboveEma20: analysis.price > analysis.ema20,
    ema20AboveEma50: analysis.ema20 > analysis.ema50,
    rsi: analysis.rsi,
    rsiInConfirmationRange: analysis.rsi >= 50 && analysis.rsi <= 68,
    macdPositive: analysis.macdHistogram > 0,
    priceAboveEma200: analysis.ema200 === null ? null : analysis.price > analysis.ema200
  };
}

export function evaluatePrediction(prediction, futurePrices) {
  if (!Array.isArray(futurePrices) || futurePrices.length < prediction.horizonSessions) return null;

  const target = futurePrices[prediction.horizonSessions - 1];
  const pricePath = futurePrices.slice(0, prediction.horizonSessions);
  const returnPercent = ((target.close - prediction.entryPrice) / prediction.entryPrice) * 100;
  const actualDirection = returnPercent > 0 ? "UP" : returnPercent < 0 ? "DOWN" : "FLAT";
  const isCorrect = prediction.signal === "HOLD" || actualDirection === "FLAT"
    ? null
    : (prediction.signal === "BUY" && actualDirection === "UP")
      || (prediction.signal === "SELL" && actualDirection === "DOWN");
  const adverseMovePercent = pricePath.reduce((worst, point) => {
    const adverseMove = prediction.signal === "SELL"
      ? ((point.close - prediction.entryPrice) / prediction.entryPrice) * 100
      : ((prediction.entryPrice - point.close) / prediction.entryPrice) * 100;
    return Math.max(worst, adverseMove);
  }, 0);

  let factors;
  try {
    factors = typeof prediction.factors === "string" ? JSON.parse(prediction.factors) : prediction.factors;
  } catch {
    throw new Error(`Prediction ${prediction.symbol ?? ""} contains an invalid factor snapshot.`);
  }

  const diagnostics = [];
  if (isCorrect === false) {
    if (prediction.signal === "BUY" && factors.priceAboveEma20 === false) {
      diagnostics.push("Price was already below EMA 20 when the BUY signal was recorded.");
    }
    if (prediction.signal === "SELL" && factors.priceAboveEma20 === true) {
      diagnostics.push("Price was already above EMA 20 when the SELL signal was recorded.");
    }
    if (prediction.signal === "BUY" && factors.ema20AboveEma50 === false) {
      diagnostics.push("The EMA 20/50 trend was not bullish at entry.");
    }
    if (prediction.signal === "SELL" && factors.ema20AboveEma50 === true) {
      diagnostics.push("The EMA 20/50 trend was not bearish at entry.");
    }
    if (prediction.signal === "BUY" && factors.macdPositive === false) {
      diagnostics.push("MACD momentum was negative at entry.");
    }
    if (prediction.signal === "SELL" && factors.macdPositive === true) {
      diagnostics.push("MACD momentum was positive at entry.");
    }
    if (factors.priceAboveEma200 !== null && factors.priceAboveEma200 !== undefined) {
      if (prediction.signal === "BUY" && factors.priceAboveEma200 === false) {
        diagnostics.push("Price was below EMA 200 at entry.");
      }
      if (prediction.signal === "SELL" && factors.priceAboveEma200 === true) {
        diagnostics.push("Price was above EMA 200 at entry.");
      }
    }
    if (factors.rsiInConfirmationRange === false) {
      diagnostics.push(`RSI ${Number(factors.rsi).toFixed(1)} was outside the strategy's 50–68 confirmation range.`);
    }
    if (diagnostics.length === 0) {
      diagnostics.push("Recorded EMA, RSI and MACD conditions aligned with the rule-based signal; the later price direction differed.");
    }
  } else if (prediction.signal === "HOLD") {
    diagnostics.push("HOLD is not direction-scored; review the realized move against the strategy's intended observation window.");
  } else if (actualDirection === "FLAT") {
    diagnostics.push("The closing price was unchanged; this result is excluded from directional accuracy.");
  }

  return {
    targetTimestamp: target.timestamp,
    targetPrice: target.close,
    actualReturnPercent: returnPercent,
    actualDirection,
    isCorrect,
    maxAdverseCloseMovePercent: Math.max(0, adverseMovePercent),
    diagnostics
  };
}
