import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import { buildCatalogResponse } from "./routes/catalog-route.js";
import { handleScenarioControl } from "./routes/control-route.js";
import type { HttpResponse } from "./routes/http-response.js";
import { jsonResponse } from "./routes/http-response.js";
import { FileScenarioStore } from "./state/file-scenario-store.js";
import type { ScenarioStore } from "./state/scenario-store.js";

const MAX_CONTROL_BODY_BYTES = 16 * 1024;

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

  const port = Number.parseInt(source, 10);
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
      throw new Error("Request body is too large.");
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

export function createTargetServer(
  scenarioStore: ScenarioStore = new FileScenarioStore(
    process.env["TARGET_STATE_PATH"] ?? "./data/target-scenario.json",
  ),
) {
  const controlToken = process.env["TARGET_CONTROL_TOKEN"];

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (request.method === "GET" && url.pathname === "/health") {
      writeResponse(
        response,
        jsonResponse(200, { status: "ok", mode: scenarioStore.get() }),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/catalog") {
      writeResponse(response, buildCatalogResponse(scenarioStore.get()));
      return;
    }

    if (request.method === "POST" && url.pathname === "/__control/scenario") {
      try {
        const body = await readJsonBody(request);
        writeResponse(
          response,
          handleScenarioControl(
            body,
            request.headers.authorization,
            controlToken,
            scenarioStore,
          ),
        );
      } catch {
        writeResponse(response, jsonResponse(400, { error: "Invalid JSON body." }));
      }
      return;
    }

    writeResponse(response, jsonResponse(404, { error: "Not found." }));
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
