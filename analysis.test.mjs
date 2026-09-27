import test from "node:test";
import assert from "node:assert/strict";
import { analyzePrices } from "./analysis.mjs";

test("analyzes a sustained uptrend as a bullish setup", () => {
  const prices = Array.from({ length: 240 }, (_, index) => 100 + index * 1.2);
  const result = analyzePrices(prices);

  assert.equal(result.signal, "BUY");
  assert.equal(result.alignedFactors, 4);
  assert.equal(result.totalFactors, 5);
  assert.equal(result.price, prices.at(-1));
  assert.ok(result.ema20 > result.ema50);
  assert.ok(result.ema50 > result.ema200);
  assert.equal(result.rsi, 100);
});

test("leaves the long-term trend unscored when fewer than 200 prices are available", () => {
  const prices = Array.from({ length: 60 }, (_, index) => 150 - index * 0.8);
  const result = analyzePrices(prices);

  assert.equal(result.ema200, null);
  assert.equal(result.totalFactors, 4);
  assert.equal(result.signal, "SELL");
});

test("rejects short, non-finite, and non-positive price histories", () => {
  assert.throws(() => analyzePrices(Array(34).fill(100)), RangeError);
  assert.throws(() => analyzePrices([...Array(34).fill(100), Number.NaN]), RangeError);
  assert.throws(() => analyzePrices([...Array(34).fill(100), 0]), RangeError);
});
