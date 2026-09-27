import test from "node:test";
import assert from "node:assert/strict";
import { captureFactors, evaluatePrediction } from "./prediction.mjs";

const bullishFactors = {
  priceAboveEma20: true,
  ema20AboveEma50: true,
  rsi: 59,
  rsiInConfirmationRange: true,
  macdPositive: true,
  priceAboveEma200: true
};

test("captures the indicator conditions and numeric RSI at the signal timestamp", () => {
  const factors = captureFactors({
    price: 120, ema20: 110, ema50: 105, ema200: null, rsi: 59, macdHistogram: 0.7
  });

  assert.deepEqual(factors, {
    priceAboveEma20: true,
    ema20AboveEma50: true,
    rsi: 59,
    rsiInConfirmationRange: true,
    macdPositive: true,
    priceAboveEma200: null
  });
});

test("scores a BUY against the close after the requested number of trading sessions", () => {
  const result = evaluatePrediction({
    signal: "BUY", entryPrice: 100, horizonSessions: 2, factors: bullishFactors
  }, [
    { timestamp: 2, close: 95 },
    { timestamp: 3, close: 110 }
  ]);

  assert.equal(result.targetTimestamp, 3);
  assert.equal(result.actualDirection, "UP");
  assert.equal(result.actualReturnPercent, 10);
  assert.equal(result.isCorrect, true);
  assert.equal(result.maxAdverseCloseMovePercent, 5);
});

test("explains a failed SELL using only its saved indicator conditions", () => {
  const result = evaluatePrediction({
    symbol: "TCS.NS",
    signal: "SELL",
    entryPrice: 100,
    horizonSessions: 1,
    factors: {
      priceAboveEma20: true,
      ema20AboveEma50: true,
      rsi: 70,
      rsiInConfirmationRange: false,
      macdPositive: true,
      priceAboveEma200: true
    }
  }, [{ timestamp: 2, close: 104 }]);

  assert.equal(result.actualDirection, "UP");
  assert.equal(result.isCorrect, false);
  assert.ok(result.diagnostics.some((reason) => reason.includes("EMA 20/50")));
  assert.ok(result.diagnostics.some((reason) => reason.includes("MACD")));
  assert.ok(result.diagnostics.some((reason) => reason.includes("RSI")));
});

test("keeps HOLD and unchanged prices out of directional accuracy", () => {
  for (const signal of ["HOLD", "BUY"]) {
    const result = evaluatePrediction({
      signal, entryPrice: 100, horizonSessions: 1, factors: bullishFactors
    }, [{ timestamp: 2, close: 100 }]);
    assert.equal(result.actualDirection, "FLAT");
    assert.equal(result.isCorrect, null);
  }
});

test("leaves an outcome pending until the full trading-session horizon is available", () => {
  const result = evaluatePrediction({
    signal: "BUY", entryPrice: 100, horizonSessions: 5, factors: bullishFactors
  }, [{ timestamp: 2, close: 101 }, { timestamp: 3, close: 102 }]);

  assert.equal(result, null);
});
