import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./database.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 3000);
const store = await createStore();
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json; charset=utf-8"]],
  ["/service-worker.js", ["service-worker.js", "text/javascript; charset=utf-8"]],
  ["/icon.svg", ["icon.svg", "image/svg+xml; charset=utf-8"]]
]);

function respondJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

async function serveStatic(pathname, response) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400).end("Invalid path.");
    return;
  }

  const file = staticFiles.get(decoded);
  if (!file) {
    response.writeHead(404).end("Not found.");
    return;
  }

  try {
    const contents = await readFile(join(root, file[0]));
    response.writeHead(200, {
      "Content-Type": file[1],
      "Cache-Control": decoded === "/service-worker.js" ? "no-cache" : "no-store",
      "Content-Security-Policy": "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(contents);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      response.writeHead(404).end("Not found.");
      return;
    }
    throw error;
  }
}

const server = createServer(async (request, response) => {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed.");
      return;
    }

    const requestUrl = new URL(request.url, "http://localhost");
    if (requestUrl.pathname === "/api/trends") {
      respondJson(response, 200, store.getDashboard());
      return;
    }

    if (requestUrl.pathname === "/api/trends/history") {
      const symbol = requestUrl.searchParams.get("symbol");
      if (!symbol || !/^(?:\^[A-Z0-9][A-Z0-9.-]{0,23}|[A-Z0-9][A-Z0-9.-]{0,23})$/.test(symbol)) {
        respondJson(response, 400, { error: "Provide a valid uppercase market ticker." });
        return;
      }
      const history = store.getAnalysisHistory(symbol);
      if (history === null) {
        respondJson(response, 404, { error: "The ticker is not configured for analysis." });
        return;
      }
      respondJson(response, 200, { symbol, historyDays: 90, history });
      return;
    }

    if (requestUrl.pathname === "/api/predictions") {
      const symbol = requestUrl.searchParams.get("symbol");
      if (!symbol || !/^(?:\^[A-Z0-9][A-Z0-9.-]{0,23}|[A-Z0-9][A-Z0-9.-]{0,23})$/.test(symbol)) {
        respondJson(response, 400, { error: "Provide a valid uppercase market ticker." });
        return;
      }
      const analytics = store.getPredictionAnalytics(symbol);
      if (analytics === null) {
        respondJson(response, 404, { error: "The ticker is not configured for analysis." });
        return;
      }
      respondJson(response, 200, { symbol, ...analytics });
      return;
    }

    if (requestUrl.pathname.startsWith("/api/")) {
      respondJson(response, 404, { error: "API endpoint not found." });
      return;
    }

    await serveStatic(requestUrl.pathname, response);
  } catch (error) {
    console.error("Request failed:", error);
    if (!response.headersSent) respondJson(response, 500, { error: "The trends server could not complete this request." });
    else response.destroy(error);
  }
});

server.on("error", (error) => {
  console.error(`Trends server could not listen on ${host}:${port}:`, error.message);
  store.close();
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`TrendSignal mobile dashboard is ready at http://${host}:${port}`);
  console.log(`Reading shared analysis database at ${store.path}`);
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
