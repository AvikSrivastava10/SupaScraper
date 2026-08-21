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
import type { HealAndVerifyDependencies } from "../../application/heal-and-verify/heal-and-verify.js";
import type { GeminiReasoner } from "../../infrastructure/gemini/gemini-adapter.js";
import type { Logger } from "../../infrastructure/logging/logger.js";
import type { DashboardDataReader } from "../../infrastructure/persistence/in-memory-repository.js";
import { renderDashboardPage, type DashboardStatus } from "../web/dashboard-page.js";

export interface ApplicationDependencies {
  readonly repository: DashboardDataReader & CatalogDataStore & RepairEventStore;
  readonly runner: CollectorRunner;
  readonly logger: Logger;
  /** Supplied only when automatic repair is enabled. */
  readonly repair?: HealAndVerifyDependencies;
  /** Supplied only when Gemini is enabled and configured. */
  readonly reasoner?: GeminiReasoner;
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
  runtime: { readonly busy: boolean; readonly lastError: string | null },
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
      busy: runtime.busy,
      lastError: runtime.lastError,
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
    // A run in progress outranks history; otherwise the state is derived from
    // the most recent event so the screen never claims something the recorded
    // history does not support.
    state: runtime.busy ? "running" : (latest?.state ?? (snapshot ? "healthy" : "idle")),
    records: snapshot?.records ?? [],
    collectedAt: snapshot?.collectedAt ?? null,
    events: recent,
    busy: runtime.busy,
    lastError: runtime.lastError,
  };
}

export interface ApplicationServer {
  readonly server: ReturnType<typeof createServer>;
  /**
   * Runs one collection through the same guarded path as the HTTP trigger.
   *
   * The scheduler uses this rather than a parallel implementation, so the
   * in-flight guard, validation, and publication rules cannot diverge.
   */
  triggerRun(): Promise<void>;
}

export function createApplicationServer(
  config: AppConfig,
  dependencies: ApplicationDependencies,
) {
  const { repository, runner, logger, repair, reasoner } = dependencies;

  // A run that triggers a repair takes many minutes, so the request must not be
  // held open for it. The trigger is accepted and the outcome is observed
  // through /api/status.
  let activeRun: Promise<void> | null = null;
  let lastRunError: string | null = null;

  /** Returns false when a run was already in flight, so nothing was started. */
  const beginRun = (): boolean => {
    const collector = config.collector;
    if (collector === null || activeRun !== null) {
      return false;
    }

    lastRunError = null;
    activeRun = (async () => {
      const run = await runCollector(collector, runner);
      await processCollectorRun(run, repository, repository, {
        autoHealEnabled: config.autoHealEnabled && repair !== undefined,
        config: collector,
        ...(repair === undefined ? {} : { repair }),
        ...(reasoner === undefined ? {} : { reasoner }),
      });
    })()
      .catch((error: unknown) => {
        lastRunError =
          error instanceof Error ? error.message : "The collector run failed.";
        logger.error("Collector run failed.", {
          collectorId: collector.collectorId,
          reason: lastRunError,
        });
      })
      .finally(() => {
        activeRun = null;
      });

    return true;
  };

  const handleRun = (request: IncomingMessage, response: ServerResponse): void => {
    if (config.apiToken !== null && !tokenAccepted(request.headers.authorization, config.apiToken)) {
      writeJson(response, 401, { error: "Unauthorized." });
      return;
    }

    if (!config.collector) {
      writeJson(response, 409, { error: "No collector is configured." });
      return;
    }

    // A run costs credit; overlapping triggers would double the spend and
    // confuse the recorded history.
    if (!beginRun()) {
      writeJson(response, 409, { error: "A run is already in progress." });
      return;
    }

    writeJson(response, 202, {
      accepted: true,
      autoHealEnabled: config.autoHealEnabled && repair !== undefined,
      message: "Run started. Poll /api/status for the outcome.",
    });
  };

  const server = createServer((request, response) => {
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
        writeJson(
          response,
          200,
          await buildStatus(config, repository, {
            busy: activeRun !== null,
            lastError: lastRunError,
          }),
        );
        return;
      }

      if (request.method === "POST" && pathname === "/api/run") {
        // The endpoint takes no input. Discard any body so the socket is not
        // left waiting on unread data.
        request.resume();
        handleRun(request, response);
        return;
      }

      if (request.method === "GET" && pathname === "/") {
        const status = await buildStatus(config, repository, {
          busy: activeRun !== null,
          lastError: lastRunError,
        });
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

  const triggerRun = async (): Promise<void> => {
    if (!beginRun()) {
      logger.info("Scheduled run skipped: a run is already in progress.");
      return;
    }
    await activeRun;
  };

  return Object.assign(server, { triggerRun });
}
