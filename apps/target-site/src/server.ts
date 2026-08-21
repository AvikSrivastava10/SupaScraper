import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import {
  buildCatalogResponse,
  buildProductResponse,
} from "./routes/catalog-route.js";
import { handleScenarioControl } from "./routes/control-route.js";
import type { HttpResponse } from "./routes/http-response.js";
import { jsonResponse } from "./routes/http-response.js";
import { FileScenarioStore } from "./state/file-scenario-store.js";
import { RequestLog } from "./state/request-log.js";
import type { ScenarioStore } from "./state/scenario-store.js";

const MAX_CONTROL_BODY_BYTES = 16 * 1024;

export class PayloadTooLargeError extends Error {
  constructor() {
    super("Request body is too large.");
    this.name = "PayloadTooLargeError";
  }
}

/**
 * Summarizes the caller without retaining an IP address.
 *
 * The diagnostic log exists to reveal which paths a remote scraper requests,
 * which does not require identifying individual visitors. Storing full
 * `x-forwarded-for` values on a public site would retain personal data for no
 * operational benefit, so only the hop count is kept.
 */
export function describeClient(forwardedFor: string | string[] | undefined): string {
  if (forwardedFor === undefined) {
    return "direct";
  }

  const raw = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor;
  const hops = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;

  return hops === 0 ? "direct" : `proxied (${String(hops)} hop${hops === 1 ? "" : "s"})`;
}

/**
 * Container hosts inject `PORT`, so it takes precedence over the local
 * `TARGET_SITE_PORT` override.
 */
export function resolvePort(
  environment: NodeJS.ProcessEnv = process.env,
  fallback = 3001,
): number {
  const source = environment["PORT"] ?? environment["TARGET_SITE_PORT"];
  if (source === undefined || source === "") {
    return fallback;
  }

  // parseInt would silently accept "1.5.5" as 1 and "3000abc" as 3000, turning
  // a typo into a different working port. Require a clean integer instead.
  const trimmed = source.trim();
  const port = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      "PORT/TARGET_SITE_PORT must be an integer between 1 and 65535.",
    );
  }

  return port;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;

    if (totalBytes > MAX_CONTROL_BODY_BYTES) {
      // Stop buffering, but leave the socket alive long enough to deliver the
      // 413. Destroying it here would surface as a network error instead.
      throw new PayloadTooLargeError();
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function writeResponse(response: ServerResponse, result: HttpResponse): void {
  response.writeHead(result.statusCode, result.headers);
  response.end(result.body);
}

/**
 * Collapses duplicate and trailing slashes so `/catalog`, `/catalog/`, and
 * `/catalog//` resolve identically.
 *
 * Bright Data's browser normalized the target URL to a trailing-slash form and
 * received a 404, which surfaced as a `dead_page` error rather than as an
 * extraction failure. Strict path matching is unrealistic for a public site and
 * would have masked the real demo.
 */
export function normalizePath(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

/** A real supplier catalog serves its landing page, so the root is included. */
const CATALOG_PATHS = new Set(["/", "/catalog"]);

export function createTargetServer(
  scenarioStore: ScenarioStore = new FileScenarioStore(
    process.env["TARGET_STATE_PATH"] ?? "./data/target-scenario.json",
  ),
) {
  const controlToken = process.env["TARGET_CONTROL_TOKEN"];
  const requestLog = new RequestLog();

  const route = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    let path: string;
    try {
      path = normalizePath(new URL(request.url ?? "/", "http://localhost").pathname);
    } catch {
      writeResponse(response, jsonResponse(400, { error: "Malformed request URL." }));
      return;
    }

    response.once("finish", () => {
      if (path === "/__control/requests") {
        return;
      }
      requestLog.record({
        at: new Date().toISOString(),
        method: request.method ?? "?",
        url: request.url ?? "?",
        status: response.statusCode,
        userAgent: request.headers["user-agent"] ?? "-",
        client: describeClient(request.headers["x-forwarded-for"]),
      });
    });

    if (request.method === "GET" && path === "/__control/requests") {
      const supplied = request.headers.authorization;
      if (!controlToken || supplied !== `Bearer ${controlToken}`) {
        writeResponse(response, jsonResponse(401, { error: "Unauthorized." }));
        return;
      }
      writeResponse(response, jsonResponse(200, { requests: requestLog.list() }));
      return;
    }

    if (request.method === "GET" && path === "/health") {
      writeResponse(
        response,
        jsonResponse(200, { status: "ok", mode: scenarioStore.get() }),
      );
      return;
    }

    if (request.method === "GET" && CATALOG_PATHS.has(path)) {
      writeResponse(response, buildCatalogResponse(scenarioStore.get()));
      return;
    }

    if (request.method === "GET" && path.startsWith("/product/")) {
      let sku: string;
      try {
        // A malformed percent-escape such as `/product/%` throws a URIError.
        sku = decodeURIComponent(path.slice("/product/".length));
      } catch {
        writeResponse(response, jsonResponse(400, { error: "Malformed product path." }));
        return;
      }
      writeResponse(response, buildProductResponse(scenarioStore.get(), sku));
      return;
    }

    if (request.method === "POST" && path === "/__control/scenario") {
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          response.once("finish", () => {
            request.destroy();
          });
          writeResponse(response, {
            statusCode: 413,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
              connection: "close",
            },
            body: JSON.stringify({ error: "Request body is too large." }),
          });
          return;
        }
        writeResponse(response, jsonResponse(400, { error: "Invalid JSON body." }));
        return;
      }

      writeResponse(
        response,
        handleScenarioControl(
          body,
          request.headers.authorization,
          controlToken,
          scenarioStore,
        ),
      );
      return;
    }

    writeResponse(response, jsonResponse(404, { error: "Not found." }));
  };

  return createServer((request, response) => {
    // Any throw here would otherwise become an unhandled rejection and leave
    // the client waiting until its own timeout.
    void route(request, response).catch(() => {
      if (response.headersSent) {
        response.end();
        return;
      }
      writeResponse(response, jsonResponse(500, { error: "Internal server error." }));
    });
  });
}

function start(): void {
  const port = resolvePort();
  const server = createTargetServer();

  server.listen(port, "0.0.0.0", () => {
    console.info(`Target site listening on http://localhost:${port}/catalog`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  start();
}
