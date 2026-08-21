import { pathToFileURL } from "node:url";

import {
  ContractPreviewReviewer,
  type HealAndVerifyDependencies,
} from "./application/heal-and-verify/heal-and-verify.js";
import { isLoopbackHost, loadConfig } from "./config/config.js";
import {
  BrightDataCliAdapter,
  ProcessCliRunner,
} from "./infrastructure/bright-data/cli-adapter.js";
import { UnconfiguredBrightDataAdapter } from "./infrastructure/bright-data/bright-data-adapter.js";
import { ConsoleLogger } from "./infrastructure/logging/logger.js";
import { JsonFileRepository } from "./infrastructure/persistence/json-file-repository.js";
import { createApplicationServer } from "./presentation/api/server.js";

export function startApplication(): void {
  const config = loadConfig();
  const logger = new ConsoleLogger();
  const repository = new JsonFileRepository(config.dataPath);

  // Without a configured collector there is nothing to run, so the adapter that
  // refuses every operation is the honest choice.
  const adapter = config.collector
    ? new BrightDataCliAdapter(new ProcessCliRunner(), logger)
    : new UnconfiguredBrightDataAdapter();

  // Repair dependencies are only assembled when automatic healing is enabled,
  // so an accidental code path cannot mutate a collector.
  const repair: HealAndVerifyDependencies | undefined =
    config.autoHealEnabled && config.collector
      ? {
          healer: adapter,
          approver: adapter,
          reviewer: new ContractPreviewReviewer(),
          runner: adapter,
          dataStore: repository,
          lock: repository,
        }
      : undefined;

  const server = createApplicationServer(config, {
    repository,
    runner: adapter,
    logger,
    ...(repair === undefined ? {} : { repair }),
  });

  server.listen(config.port, config.host, () => {
    logger.info("SupaScraper is listening.", {
      host: config.host,
      port: config.port,
      collectorConfigured: config.collector !== null,
      geminiEnabled: config.geminiEnabled,
      autoHealEnabled: repair !== undefined,
      runEndpointProtected: config.apiToken !== null,
    });

    if (repair !== undefined) {
      logger.info(
        "Automatic repair is enabled. A confident structural break will heal, review the preview, approve with save, and verify.",
        { collectorId: config.collector?.collectorId ?? "none" },
      );
    }

    if (!isLoopbackHost(config.host)) {
      logger.info(
        "Bound to a non-loopback address; the run endpoint requires a bearer token.",
        { host: config.host },
      );
    }
  });

  const shutdown = () => {
    server.close(() => {
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
