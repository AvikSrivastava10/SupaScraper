import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { HealAndVerifyDependencies } from "../../application/heal-and-verify/heal-and-verify.js";
import type {
  CatalogDataStore,
  RepairEventStore,
} from "../../application/process-run/process-run.js";
import { processCollectorRun } from "../../application/process-run/process-run.js";
import type { CollectorRunner } from "../../application/run-collector/run-collector.js";
import { runCollector } from "../../application/run-collector/run-collector.js";
import { isLoopbackHost, type AppConfig } from "../../config/config.js";
import type { TargetConfig } from "../../config/targets.js";
import type { GeminiReasoner } from "../../infrastructure/gemini/gemini-adapter.js";
import type { Logger } from "../../infrastructure/logging/logger.js";
import type { DashboardDataReader } from "../../infrastructure/persistence/in-memory-repository.js";
import {
  renderDashboardPage,
  type DashboardStatus,
  type TargetStatus,
} from "../web/dashboard-page.js";

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

export function createApplicationServer(
  config: AppConfig,
  dependencies: ApplicationDependencies,
) {
  const { repository, runner, logger, repair, reasoner } = dependencies;

  // One in-flight run per target, so a slow repair on one site never blocks
  // collection from another.
  const active = new Map<string, Promise<void>>();
  const errors = new Map<string, string>();

  const buildTargetStatus = async (target: TargetConfig): Promise<TargetStatus> => {
    const [snapshot, events] = await Promise.all([
      repository.getLastKnownGood(target.collectorId),
      repository.listEvents(target.collectorId),
    ]);

    const recent = [...events].reverse().slice(0, 6);
    const latest = recent[0];
    const busy = active.has(target.id);

    return {
      id: target.id,
      label: target.label,
      collectorId: target.collectorId,
      targetUrl: target.targetUrl,
      controllable: target.controllable,
      state: busy ? "running" : (latest?.state ?? (snapshot ? "healthy" : "idle")),
      records: snapshot?.records ?? [],
      collectedAt: snapshot?.collectedAt ?? null,
      events: recent,
      busy,
      lastError: errors.get(target.id) ?? null,
    };
  };

  const buildStatus = async (): Promise<DashboardStatus> => ({
    configured: config.targets.length > 0,
    autoHealEnabled: config.autoHealEnabled && repair !== undefined,
    geminiEnabled: reasoner !== undefined,
    scheduleMinutes:
      config.scheduleIntervalMs === null
        ? null
        : Math.round(config.scheduleIntervalMs / 60_000),
    targets: await Promise.all(config.targets.map((target) => buildTargetStatus(target))),
  });

  /** Returns false when this target already has a run in flight. */
  const beginRun = (target: TargetConfig): boolean => {
    if (active.has(target.id)) {
      return false;
    }

    errors.delete(target.id);
    const work = (async () => {
      const run = await runCollector(target, runner);
      await processCollectorRun(run, repository, repository, {
        autoHealEnabled: config.autoHealEnabled && repair !== undefined,
        config: target,
        ...(repair === undefined ? {} : { repair }),
        ...(reasoner === undefined ? {} : { reasoner }),
      });
    })()
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "The collector run failed.";
        errors.set(target.id, message);
        logger.error("Collector run failed.", {
          target: target.id,
          collectorId: target.collectorId,
          reason: message,
        });
      })
      .finally(() => {
        active.delete(target.id);
      });

    active.set(target.id, work);
    return true;
  };

  const handleRun = (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): void => {
    if (
      config.apiToken !== null &&
      !tokenAccepted(request.headers.authorization, config.apiToken)
    ) {
      writeJson(response, 401, { error: "Unauthorized." });
      return;
    }

    if (config.targets.length === 0) {
      writeJson(response, 409, { error: "No targets are configured." });
      return;
    }

    // A specific target may be requested; otherwise every target is collected.
    const requested = url.searchParams.get("target");
    const selected =
      requested === null
        ? config.targets
        : config.targets.filter((target) => target.id === requested);

    if (selected.length === 0) {
      writeJson(response, 404, { error: `Unknown target "${String(requested)}".` });
      return;
    }

    const started = selected.filter((target) => beginRun(target)).map((t) => t.id);
    const skipped = selected
      .filter((target) => !started.includes(target.id))
      .map((t) => t.id);

    if (started.length === 0) {
      writeJson(response, 409, {
        error: "A run is already in progress for every requested target.",
        skipped,
      });
      return;
    }

    writeJson(response, 202, {
      accepted: true,
      started,
      skipped,
      autoHealEnabled: config.autoHealEnabled && repair !== undefined,
      message: "Run started. Poll /api/status for the outcome.",
    });
  };

  const server = createServer((request, response) => {
    void (async () => {
      let url: URL;
      try {
        url = new URL(request.url ?? "/", "http://localhost");
      } catch {
        writeJson(response, 400, { error: "Malformed request URL." });
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, {
          status: "ok",
          targets: config.targets.length,
          exposed: !isLoopbackHost(config.host),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/status") {
        writeJson(response, 200, await buildStatus());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/run") {
        request.resume();
        handleRun(request, response, url);
        return;
      }

      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(renderDashboardPage(await buildStatus()));
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

  /**
   * Collects every target once, awaiting completion.
   *
   * The scheduler uses this rather than a parallel implementation, so unattended
   * runs inherit the same guards as an HTTP trigger.
   */
  const triggerRun = async (): Promise<void> => {
    const started = config.targets.filter((target) => beginRun(target));
    if (started.length === 0) {
      logger.info("Scheduled run skipped: every target is already running.");
      return;
    }
    await Promise.all(started.map((target) => active.get(target.id)));
  };

  return Object.assign(server, { triggerRun });
}
