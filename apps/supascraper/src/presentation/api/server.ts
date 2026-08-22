import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  addTarget,
  SiteInputError,
  type CollectorFactory,
} from "../../application/add-target/add-target.js";
import type { TargetRegistry } from "../../application/add-target/target-registry.js";
import type { HealAndVerifyDependencies } from "../../application/heal-and-verify/heal-and-verify.js";
import type {
  RepairEventStore,
  ScrapedDataStore,
} from "../../application/process-run/process-run.js";
import { processCollectorRun } from "../../application/process-run/process-run.js";
import type { CollectorRunner } from "../../application/run-collector/run-collector.js";
import { runCollector } from "../../application/run-collector/run-collector.js";
import { isLoopbackHost, type AppConfig } from "../../config/config.js";
import type { TargetConfig } from "../../config/targets.js";
import { orderedFields } from "../../domain/contracts/data-contract.js";
import type { GeminiReasoner } from "../../infrastructure/gemini/gemini-adapter.js";
import type { Logger } from "../../infrastructure/logging/logger.js";
import type { DashboardDataReader } from "../../infrastructure/persistence/in-memory-repository.js";
import { InMemoryActivityLog } from "../../infrastructure/persistence/activity-log.js";
import { exportRecords, isExportFormat, EXPORT_FORMATS } from "../export/export-records.js";
import {
  renderDashboardPage,
  type DashboardStatus,
  type TargetStatus,
} from "../web/dashboard-page.js";

export interface ApplicationDependencies {
  readonly repository: DashboardDataReader & ScrapedDataStore & RepairEventStore;
  readonly runner: CollectorRunner;
  readonly logger: Logger;
  /** Source of truth for which sites are monitored, including runtime additions. */
  readonly targets: TargetRegistry;
  /** Supplied only when new scrapers can actually be built. */
  readonly factory?: CollectorFactory;
  /** Supplied only when automatic repair is enabled. */
  readonly repair?: HealAndVerifyDependencies;
  /** Supplied only when Gemini is enabled and configured. */
  readonly reasoner?: GeminiReasoner;
}

/** Enough for a URL and a 500-character description, and nothing more. */
const MAX_BODY_BYTES = 8 * 1024;

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

/**
 * Reads a JSON body, refusing anything oversized.
 *
 * The limit is enforced while reading rather than after, so an oversized body is
 * abandoned instead of buffered.
 */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new SiteInputError("The request body is too large.");
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SiteInputError("The request body must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SiteInputError("The request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

const EXPORT_ROUTE = /^\/api\/targets\/([^/]+)\/export$/;

export function createApplicationServer(
  config: AppConfig,
  dependencies: ApplicationDependencies,
) {
  const { repository, runner, logger, targets, factory, repair, reasoner } = dependencies;

  // One in-flight run per target, so a slow repair on one site never blocks
  // collection from another.
  const active = new Map<string, Promise<void>>();
  const errors = new Map<string, string>();

  // Live progress, so a build or repair that runs for minutes is observable
  // rather than a spinner followed by a verdict.
  const activity = new InMemoryActivityLog();

  const autoHealEnabled = config.autoHealEnabled && repair !== undefined;

  const requireToken = (
    request: IncomingMessage,
    response: ServerResponse,
  ): boolean => {
    if (config.apiToken === null) {
      return true;
    }
    if (tokenAccepted(request.headers.authorization, config.apiToken)) {
      return true;
    }
    writeJson(response, 401, { error: "Unauthorized." });
    return false;
  };

  const buildTargetStatus = async (target: TargetConfig): Promise<TargetStatus> => {
    const [snapshot, events, contract] = await Promise.all([
      repository.getLastKnownGood(target.collectorId),
      repository.listEvents(target.collectorId),
      repository.getContract(target.collectorId),
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
      contract,
      provisioning: null,
      steps: activity.list(target.id),
    };
  };

  /** A site whose scraper is still being built has no data to report yet. */
  const buildPendingStatus = (): TargetStatus[] =>
    targets.pending().map((entry) => ({
      id: entry.id,
      label: entry.label,
      collectorId: "not built yet",
      targetUrl: entry.targetUrl,
      controllable: false,
      state: "idle" as const,
      records: [],
      collectedAt: null,
      events: [],
      busy: false,
      lastError: entry.status === "failed" ? entry.message : null,
      contract: null,
      provisioning:
        entry.status === "failed"
          ? null
          : "Bright Data is building a scraper for this page. This usually takes 5 to 10 minutes.",
      steps: activity.list(entry.id),
    }));

  const buildStatus = async (): Promise<DashboardStatus> => {
    const live = await Promise.all(
      targets.list().map((target) => buildTargetStatus(target)),
    );
    const all = [...live, ...buildPendingStatus()];

    return {
      configured: all.length > 0,
      autoHealEnabled,
      geminiEnabled: reasoner !== undefined,
      scheduleMinutes:
        config.scheduleIntervalMs === null
          ? null
          : Math.round(config.scheduleIntervalMs / 60_000),
      targets: all,
      canAddTargets: factory !== undefined,
      requiresToken: config.apiToken !== null,
    };
  };

  /** Returns false when this target already has a run in flight. */
  const beginRun = (target: TargetConfig): boolean => {
    if (active.has(target.id)) {
      return false;
    }

    errors.delete(target.id);
    const report = activity.reporterFor(target.id);

    const work = (async () => {
      // A fresh sequence per run, so the display shows this attempt rather than
      // an ever-growing log the reader has to scroll.
      activity.begin(target.id);
      report({
        stage: "collect",
        status: "started",
        detail: `Running collector ${target.collectorId} against ${target.targetUrl}.`,
      });

      const run = await runCollector(target, runner);

      report({
        stage: "collect",
        status: run.status === "succeeded" ? "done" : "failed",
        detail:
          run.status === "succeeded"
            ? "The collector finished and returned output."
            : (run.safeError?.message ?? `The run ended as ${run.status}.`),
      });

      await processCollectorRun(run, repository, repository, {
        autoHealEnabled,
        config: target,
        progress: report,
        ...(repair === undefined ? {} : { repair }),
        ...(reasoner === undefined ? {} : { reasoner }),
      });
    })()
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "The collector run failed.";
        errors.set(target.id, message);
        report({ stage: "collect", status: "failed", detail: message });
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
    if (!requireToken(request, response)) {
      return;
    }

    const registered = targets.list();
    if (registered.length === 0) {
      writeJson(response, 409, { error: "No targets are configured." });
      return;
    }

    // A specific target may be requested; otherwise every target is collected.
    const requested = url.searchParams.get("target");
    const selected =
      requested === null
        ? registered
        : registered.filter((target) => target.id === requested);

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
      autoHealEnabled,
      message: "Run started. Poll /api/status for the outcome.",
    });
  };

  /**
   * Accepts a user-supplied website.
   *
   * The response returns as soon as the site is registered, because building the
   * scraper takes minutes. Progress appears on the dashboard.
   */
  const handleAddTarget = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (!requireToken(request, response)) {
      request.resume();
      return;
    }

    if (factory === undefined) {
      request.resume();
      writeJson(response, 503, {
        error:
          "This deployment cannot build new scrapers because the Bright Data CLI is not available.",
      });
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      writeJson(response, 400, {
        error: error instanceof Error ? error.message : "Malformed request body.",
      });
      return;
    }

    try {
      const result = addTarget(
        {
          url: typeof body["url"] === "string" ? body["url"] : "",
          description:
            typeof body["description"] === "string" ? body["description"] : "",
          label: readOptionalString(body["label"]),
        },
        {
          registry: targets,
          factory,
          logger,
          timeoutMs: config.defaultRunTimeoutMs,
          // Collect immediately, so the first good run can learn the contract
          // without the user having to press anything.
          onReady: (target) => {
            beginRun(target);
          },
          // Provisioning steps are recorded against the new target's id, which
          // add-target derives, so the reporter has to be built after validation.
          progressFor: (targetId) => {
            activity.begin(targetId);
            return activity.reporterFor(targetId);
          },
        },
      );

      // Deliberately not awaited: provisioning outlives this request.
      void result.completion;

      writeJson(response, 202, {
        accepted: true,
        target: result.pending,
        message:
          "Building a scraper for this page. It appears on the dashboard while Bright Data works, and collects automatically once ready.",
      });
    } catch (error) {
      if (error instanceof SiteInputError) {
        writeJson(response, 400, { error: error.message });
        return;
      }
      throw error;
    }
  };

  /** Serves verified rows as a downloadable document. */
  const handleExport = async (
    response: ServerResponse,
    targetId: string,
    url: URL,
  ): Promise<void> => {
    const target = targets.get(targetId);
    if (target === null) {
      writeJson(response, 404, { error: `Unknown target "${targetId}".` });
      return;
    }

    const requested = url.searchParams.get("format") ?? "json";
    if (!isExportFormat(requested)) {
      writeJson(response, 400, {
        error: `Unsupported format "${requested}".`,
        supported: EXPORT_FORMATS,
      });
      return;
    }

    const [snapshot, contract] = await Promise.all([
      repository.getLastKnownGood(target.collectorId),
      repository.getContract(target.collectorId),
    ]);
    const records = snapshot?.records ?? [];

    if (records.length === 0) {
      writeJson(response, 409, {
        error: "No verified data has been collected for this target yet.",
      });
      return;
    }

    const result = exportRecords(records, {
      format: requested,
      name: target.label,
      collectedAt: snapshot?.collectedAt ?? null,
      // Every field the site returned, not just the columns the dashboard shows
      // or the fields the contract happens to require.
      columns: orderedFields(contract, records),
    });

    response.writeHead(200, {
      "content-type": result.contentType,
      "cache-control": "no-store",
      // Quoted and slug-derived, so the header cannot be broken by a site's label.
      "content-disposition": `attachment; filename="${result.fileName}"`,
    });
    response.end(result.body);
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
          targets: targets.list().length,
          pending: targets.pending().length,
          exposed: !isLoopbackHost(config.host),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/status") {
        writeJson(response, 200, await buildStatus());
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/targets") {
        writeJson(response, 200, {
          targets: targets.list().map((target) => ({
            id: target.id,
            label: target.label,
            collectorId: target.collectorId,
            targetUrl: target.targetUrl,
            fieldDescription: target.fieldDescription,
            controllable: target.controllable,
          })),
          pending: targets.pending(),
          exportFormats: EXPORT_FORMATS,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/targets") {
        await handleAddTarget(request, response);
        return;
      }

      const exportMatch = EXPORT_ROUTE.exec(url.pathname);
      if (request.method === "GET" && exportMatch?.[1] !== undefined) {
        await handleExport(response, decodeURIComponent(exportMatch[1]), url);
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
    })().catch((error: unknown) => {
      logger.error("Request handling failed.", {
        reason: error instanceof Error ? error.message : "unknown",
      });
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
    const started = targets.list().filter((target) => beginRun(target));
    if (started.length === 0) {
      logger.info("Scheduled run skipped: every target is already running or none exist.");
      return;
    }
    await Promise.all(started.map((target) => active.get(target.id)));
  };

  return Object.assign(server, { triggerRun });
}
