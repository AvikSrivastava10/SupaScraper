import { pathToFileURL } from "node:url";

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
import { createApplicationServer } from "./presentation/api/server.js";

export function startApplication(): void {
  const config = loadConfig();
  const logger = new ConsoleLogger();
  const repository = new JsonFileRepository(config.dataPath);

  // Without a configured target there is nothing to run, so the adapter that
  // refuses every operation is the honest choice.
  const adapter =
    config.targets.length > 0
      ? new BrightDataCliAdapter(new ProcessCliRunner(), logger)
      : new UnconfiguredBrightDataAdapter();

  // Repair dependencies are only assembled when automatic healing is enabled,
  // so an accidental code path cannot mutate a collector.
  const repair: HealAndVerifyDependencies | undefined =
    config.autoHealEnabled && config.targets.length > 0
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
      reasoner = new HttpGeminiReasoner({ apiKey }, logger);
    }
  }

  const app = createApplicationServer(config, {
    repository,
    runner: adapter,
    logger,
    ...(repair === undefined ? {} : { repair }),
    ...(reasoner === undefined ? {} : { reasoner }),
  });

  let scheduler: SchedulerHandle | null = null;

  app.listen(config.port, config.host, () => {
    logger.info("SupaScraper is listening.", {
      host: config.host,
      port: config.port,
      targets: config.targets.length,
      autoHealEnabled: repair !== undefined,
      geminiEnabled: reasoner !== undefined,
      runEndpointProtected: config.apiToken !== null,
    });

    for (const target of config.targets) {
      logger.info("Monitoring target.", {
        id: target.id,
        collectorId: target.collectorId,
        url: target.targetUrl,
        controllable: target.controllable,
      });
    }

    if (repair !== undefined) {
      logger.info(
        "Automatic repair is enabled. A confident structural break will heal, review the preview, approve with save, and verify.",
      );
    }

    if (!isLoopbackHost(config.host)) {
      logger.info(
        "Bound to a non-loopback address; the run endpoint requires a bearer token.",
        { host: config.host },
      );
    }

    // The schedule reuses the server's guarded trigger, so unattended runs obey
    // the same in-flight guard and publication rules as a manual one.
    if (config.scheduleIntervalMs !== null && config.targets.length > 0) {
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
