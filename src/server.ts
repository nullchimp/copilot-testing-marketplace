import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ReportError } from "./model.js";
import { inputObject, runId } from "./inputs.js";
import type { ReportStore } from "./store.js";

export interface RenderStatus {
  pageLoads: number;
  lastRender: { at: string; runId: string | null; testRows: number } | null;
}

export interface DashboardServer {
  url: string;
  refresh: (selected?: string) => void;
  status: () => RenderStatus;
  close: () => Promise<void>;
}

async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"] !== "application/json") throw new ReportError("invalid_input", "Expected application/json.");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 4096) throw new ReportError("invalid_input", "Request exceeds 4096 bytes.");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ReportError("invalid_input", "Request body is not valid JSON.");
  }
}

export async function startDashboard(store: ReportStore, publicDirectory: string): Promise<DashboardServer> {
  const names = ["index.html", "app.js", "style.css"] as const;
  const assets = new Map<string, Buffer>(await Promise.all(names.map(async name => [name, await readFile(join(publicDirectory, name))] as const)));
  const token = randomBytes(24).toString("hex");
  const prefix = `/${token}/`;
  const clients = new Set<ServerResponse>();
  const health: RenderStatus = { pageLoads: 0, lastRender: null };
  let selected: string | undefined;
  let origin = "";
  let closing = false;
  const server = createServer((req, res) => {
    void route(req, res).catch(error => {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : new Error("Response failed."));
        return;
      }
      res.statusCode = error instanceof ReportError && error.code === "invalid_input" ? 400 : 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: { code: error instanceof ReportError ? error.code : "server_error", message: error instanceof Error ? error.message : "Dashboard request failed." } }));
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 2_000;
  server.maxHeadersCount = 40;

  async function route(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'");
    if (closing || req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) ||
        (req.headers["sec-fetch-site"] === "cross-site" && req.headers["sec-fetch-dest"] !== "iframe")) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? "/", origin);
    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(404).end();
      return;
    }
    const path = url.pathname.slice(prefix.length);
    if (req.method === "GET" && (path === "" || assets.has(path))) {
      const name = path || "index.html";
      res.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript; charset=utf-8" : name.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8");
      if (name === "index.html") health.pageLoads++;
      res.end(assets.get(name));
    } else if (req.method === "GET" && path === "api/state") {
      const explicit = url.searchParams.get("runId");
      const id = explicit ? runId(explicit) : selected;
      const data = await store.read(id ? { runId: id } : {});
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(data));
    } else if (req.method === "GET" && path === "events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
    } else if (req.method === "POST" && path === "api/rendered") {
      const data = inputObject(await body(req), ["runId", "testRows"]);
      const id = data.runId === null ? null : runId(data.runId);
      if (typeof data.testRows !== "number" || !Number.isInteger(data.testRows) || data.testRows < 0 || data.testRows > 200) {
        throw new ReportError("invalid_input", "Invalid rendered row count.");
      }
      health.lastRender = { at: new Date().toISOString(), runId: id, testRows: data.testRows };
      res.writeHead(204).end();
    } else {
      res.writeHead(404).end();
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new ReportError("server_error", "No loopback address was assigned.");
  }
  origin = `http://127.0.0.1:${address.port}`;
  const heartbeat = setInterval(() => { for (const client of clients) client.write(": heartbeat\n\n"); }, 15_000);
  heartbeat.unref();
  return {
    url: `${origin}${prefix}`,
    refresh(id) {
      selected = id;
      for (const client of clients) client.write(`event: refresh\ndata: ${JSON.stringify({ runId: id ?? null })}\n\n`);
    },
    status: () => structuredClone(health),
    async close() {
      closing = true;
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      clients.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
