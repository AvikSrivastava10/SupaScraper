import { createServer, type ServerResponse } from "node:http";

import type { AppConfig } from "../../config/config.js";
import type { Logger } from "../../infrastructure/logging/logger.js";
import type { DashboardDataReader } from "../../infrastructure/persistence/in-memory-repository.js";
import {
  renderDashboardPage,
  type DashboardStatus,
} from "../web/dashboard-page.js";

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function buildStatus(
  config: AppConfig,
  repository: DashboardDataReader,
): Promise<DashboardStatus> {
  if (!config.collector) {
    return {
      configured: false,
      collectorId: null,
      targetUrl: null,
      state: "idle",
      records: [],
      collectedAt: null,
      eventCount: 0,
    };
  }

  const [snapshot, events] = await Promise.all([
    repository.getLastKnownGood(config.collector.collectorId),
    repository.listEvents(config.collector.collectorId),
  ]);

  return {
    configured: true,
    collectorId: config.collector.collectorId,
    targetUrl: config.collector.targetUrl,
    state: "idle",
    records: snapshot?.records ?? [],
    collectedAt: snapshot?.collectedAt ?? null,
    eventCount: events.length,
  };
}

export function createApplicationServer(
  config: AppConfig,
  repository: DashboardDataReader,
  logger: Logger,
) {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, {
          status: "ok",
          collectorConfigured: config.collector !== null,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/status") {
        writeJson(response, 200, await buildStatus(config, repository));
        return;
      }

      if (request.method === "GET" && url.pathname === "/") {
        const status = await buildStatus(config, repository);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(renderDashboardPage(status));
        return;
      }

      writeJson(response, 404, { error: "Not found." });
    } catch {
      logger.error("Request handling failed.");
      writeJson(response, 500, { error: "Internal server error." });
    }
  });
}
