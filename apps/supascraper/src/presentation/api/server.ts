import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { isLoopbackHost, type AppConfig } from "../../config/config.js";
import { processCollectorRun } from "../../application/process-run/process-run.js";
import { runCollector } from "../../application/run-collector/run-collector.js";
import type { CollectorRunner } from "../../application/run-collector/run-collector.js";
import type {
  CatalogDataStore,
  RepairEventStore,
} from "../../application/process-run/process-run.js";
import type { Logger } from "../../infrastructure/logging/logger.js";
import type { DashboardDataReader } from "../../infrastructure/persistence/in-memory-repository.js";
import { renderDashboardPage, type DashboardStatus } from "../web/dashboard-page.js";

export interface ApplicationDependencies {
  readonly repository: DashboardDataReader & CatalogDataStore & RepairEventStore;
  readonly runner: CollectorRunner;
  readonly logger: Logger;
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function tokenAccepted(supplied: string | undefined, expected: string): boolean {
  if (supplied === undefined || !supplied.startsWith("Bearer ")) {
    return false;
  }
  const given = Buffer.from(supplied.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
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
      events: [],
    };
  }

  const [snapshot, events] = await Promise.all([
    repository.getLastKnownGood(config.collector.collectorId),
    repository.listEvents(config.collector.collectorId),
  ]);

  const recent = [...events].reverse().slice(0, 10);
  const latest = recent[0];

  return {
    configured: true,
    collectorId: config.collector.collectorId,
    targetUrl: config.collector.targetUrl,
    // Derived from the most recent event so the screen never claims a state the
    // recorded history does not support.
    state: latest?.state ?? (snapshot ? "healthy" : "idle"),
    records: snapshot?.records ?? [],
    collectedAt: snapshot?.collectedAt ?? null,
    events: recent,
  };
}

export function createApplicationServer(
  config: AppConfig,
  dependencies: ApplicationDependencies,
) {
  const { repository, runner, logger } = dependencies;
  let runInFlight = false;

  const handleRun = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (config.apiToken !== null && !tokenAccepted(request.headers.authorization, config.apiToken)) {
      writeJson(response, 401, { error: "Unauthorized." });
      return;
    }

    if (!config.collector) {
      writeJson(response, 409, { error: "No collector is configured." });
      return;
    }

    // A run costs credit and takes time; overlapping triggers would double the
    // spend and confuse the recorded history.
    if (runInFlight) {
      writeJson(response, 409, { error: "A run is already in progress." });
      return;
    }

    runInFlight = true;
    try {
      const run = await runCollector(config.collector, runner);
      const outcome = await processCollectorRun(run, repository, repository);
      writeJson(response, 200, {
        status: run.status,
        classification: outcome.decision.classification,
        recommendedAction: outcome.decision.recommendedAction,
        evidence: outcome.decision.evidence,
        published: outcome.published,
        rowCount: outcome.evaluation.metrics.rowCount,
        validRowCount: outcome.evaluation.metrics.validRowCount,
      });
    } catch (error) {
      logger.error("Manual collector run failed.", {
        collectorId: config.collector.collectorId,
        reason: error instanceof Error ? error.message : "unknown",
      });
      writeJson(response, 502, {
        error: "The collector run could not be completed.",
      });
    } finally {
      runInFlight = false;
    }
  };

  return createServer((request, response) => {
    void (async () => {
      let pathname: string;
      try {
        pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      } catch {
        writeJson(response, 400, { error: "Malformed request URL." });
        return;
      }

      if (request.method === "GET" && pathname === "/health") {
        writeJson(response, 200, {
          status: "ok",
          collectorConfigured: config.collector !== null,
          exposed: !isLoopbackHost(config.host),
        });
        return;
      }

      if (request.method === "GET" && pathname === "/api/status") {
        writeJson(response, 200, await buildStatus(config, repository));
        return;
      }

      if (request.method === "POST" && pathname === "/api/run") {
        // The endpoint takes no input. Discard any body so the socket is not
        // left waiting on unread data.
        request.resume();
        await handleRun(request, response);
        return;
      }

      if (request.method === "GET" && pathname === "/") {
        const status = await buildStatus(config, repository);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(renderDashboardPage(status));
        return;
      }

      writeJson(response, 404, { error: "Not found." });
    })().catch(() => {
      logger.error("Request handling failed.");
      if (!response.headersSent) {
        writeJson(response, 500, { error: "Internal server error." });
      } else {
        response.end();
      }
    });
  });
}
