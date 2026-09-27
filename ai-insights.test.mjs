import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { generateInsight } from "./ai-insights.mjs";

async function withOllamaResponse(response, callback) {
  let requestBody;
  const server = createServer(async (request, res) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(response.status ?? 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response.body ?? {
      message: { content: JSON.stringify(response.content) }
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}`, () => requestBody);
  } finally {
    server.close();
    await once(server, "close");
  }
}

const sampleInput = {
  asset: { symbol: "INFY.NS", name: "Infosys", exchange: "NSE" },
  market: {
    prices: [
      { timestamp: 1_790_000_000, close: 1500 },
      { timestamp: 1_790_086_400, close: 1515 }
    ]
  },
  analysis: {
    signal: "BUY",
    alignedFactors: 4,
    totalFactors: 5,
    ema20: 1490,
    ema50: 1470,
    ema200: 1400,
    rsi: 61,
    macdHistogram: 0.42
  }
};

test("generates a structured, local-model-only market explanation", async () => {
  const content = {
    summary: "The daily trend setup is positive across most indicators.",
    drivers: ["The close is above the 20-day EMA."],
    risks: ["Daily prices may be delayed."]
  };

  await withOllamaResponse({ content }, async (baseUrl, getRequestBody) => {
    const insight = await generateInsight(sampleInput, { baseUrl, model: "test-model" });
    const body = getRequestBody();

    assert.deepEqual(insight, { model: "test-model", ...content });
    assert.equal(body.model, "test-model");
    assert.equal(body.stream, false);
    assert.equal(body.keep_alive, "10m");
    assert.deepEqual(body.format.required, ["summary", "drivers", "risks"]);
    assert.equal(body.format.properties.drivers.maxItems, 3);
    assert.match(body.messages[0].content, /Do not predict prices/);
    assert.match(body.messages[1].content, /daily closing prices; may be delayed/);
  });
});

test("rejects malformed local-model output instead of displaying unvalidated text", async () => {
  await withOllamaResponse({
    content: { summary: "A recommendation to buy immediately.", drivers: "not a list", risks: [] }
  }, async (baseUrl) => {
    await assert.rejects(generateInsight(sampleInput, { baseUrl }), /invalid insight format/);
  });
});

test("reports Ollama's missing-model error explicitly", async () => {
  await withOllamaResponse({
    status: 404,
    body: { error: "model not found" }
  }, async (baseUrl) => {
    await assert.rejects(
      generateInsight(sampleInput, { baseUrl, model: "missing-model" }),
      /ollama pull missing-model/
    );
  });
});
