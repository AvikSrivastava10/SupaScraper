import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { CollectorFactory } from "./application/add-target/add-target.js";
import {
  ContractPreviewReviewer,
  type HealAndVerifyDependencies,
} from "./application/heal-and-verify/heal-and-verify.js";
import { startScheduler, type SchedulerHandle } from "./application/schedule/scheduler.js";
import { isLoopbackHost, loadConfig } from "./config/config.js";
import { UnconfiguredBrightDataAdapter } from "./infrastructure/bright-data/bright-data-adapter.js";
import {
  BrightDataCliAdapter,
  ProcessCliRunner,
} from "./infrastructure/bright-data/cli-adapter.js";
import {
  HttpGeminiReasoner,
  type GeminiReasoner,
} from "./infrastructure/gemini/gemini-adapter.js";
import { ConsoleLogger } from "./infrastructure/logging/logger.js";
import { JsonFileRepository } from "./infrastructure/persistence/json-file-repository.js";
import { FileTargetRegistry } from "./infrastructure/persistence/target-store.js";
import { createApplicationServer } from "./presentation/api/server.js";

const CLI_ENTRY_POINT = "node_modules/@brightdata/cli/dist/index.js";

export function startApplication(): void {
  const config = loadConfig();
  const logger = new ConsoleLogger();
  const repository = new JsonFileRepository(config.dataPath);

  // Sites can now be added while the process runs, so the registry rather than
  // the config is the source of truth for what is monitored.
  const registry = new FileTargetRegistry(
    config.targets,
    config.addedTargetsPath,
    config.defaultRunTimeoutMs,
  );

  // Availability is decided by whether the pinned CLI is actually on disk, not
  // by whether a target happens to be configured. A site added through the
  // dashboard needs the CLI before any target exists.
  const cliAvailable = existsSync(resolve(CLI_ENTRY_POINT));
  const adapter = cliAvailable
    ? new BrightDataCliAdapter(new ProcessCliRunner(), logger)
    : new UnconfiguredBrightDataAdapter();

  const factory: CollectorFactory | undefined = cliAvailable ? adapter : undefined;

  // Repair dependencies are only assembled when automatic healing is enabled,
  // so an accidental code path cannot mutate a collector.
  const repair: HealAndVerifyDependencies | undefined =
    config.autoHealEnabled && cliAvailable
      ? {
          healer: adapter,
          approver: adapter,
          reviewer: new ContractPreviewReviewer(),
          runner: adapter,
          dataStore: repository,
          lock: repository,
        }
      : undefined;

  // Gemini is optional in the strongest sense: absent configuration simply
  // means the deterministic detector is the only voice.
  let reasoner: GeminiReasoner | undefined;
  if (config.geminiEnabled) {
    const apiKey = process.env["GEMINI_API_KEY"];
    if (apiKey === undefined || apiKey.trim().length === 0) {
      logger.info("Gemini is enabled but no API key is set; continuing without it.");
    } else {
      reasoner = new HttpGeminiReasoner({ apiKey, model: config.geminiModel }, logger);
      logger.info("Gemini reasoning is enabled.", { model: config.geminiModel });
    }
  }

  const app = createApplicationServer(config, {
    repository,
    runner: adapter,
    logger,
    targets: registry,
    ...(factory === undefined ? {} : { factory }),
    ...(repair === undefined ? {} : { repair }),
    ...(reasoner === undefined ? {} : { reasoner }),
  });

  let scheduler: SchedulerHandle | null = null;

  app.listen(config.port, config.host, () => {
    logger.info("SupaScraper is listening.", {
      host: config.host,
      port: config.port,
      targets: registry.list().length,
      pending: registry.pending().length,
      canAddSites: factory !== undefined,
      autoHealEnabled: repair !== undefined,
      geminiEnabled: reasoner !== undefined,
      runEndpointProtected: config.apiToken !== null,
    });

    for (const target of registry.list()) {
      logger.info("Monitoring target.", {
        id: target.id,
        collectorId: target.collectorId,
        url: target.targetUrl,
        controllable: target.controllable,
      });
    }

    if (!cliAvailable) {
      logger.info(
        "The Bright Data CLI was not found, so collection and site creation are disabled.",
        { expectedAt: CLI_ENTRY_POINT },
      );
    }

    if (repair !== undefined) {
      logger.info(
        "Automatic repair is enabled. A confident structural break will heal, review the preview, approve with save, and verify.",
      );
    }

    if (!isLoopbackHost(config.host)) {
      logger.info(
        "Bound to a non-loopback address; write endpoints require a bearer token.",
        { host: config.host },
      );
    }

    // The schedule reuses the server's guarded trigger, so unattended runs obey
    // the same in-flight guard and publication rules as a manual one.
    if (config.scheduleIntervalMs !== null) {
      scheduler = startScheduler({
        intervalMs: config.scheduleIntervalMs,
        trigger: () => app.triggerRun(),
        logger,
      });
    }
  });

  const shutdown = () => {
    scheduler?.stop();
    app.close(() => {
      process.exit(0);
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  startApplication();
}
