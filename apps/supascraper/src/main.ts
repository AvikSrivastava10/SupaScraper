import { pathToFileURL } from "node:url";

import { loadConfig } from "./config/config.js";
import { ConsoleLogger } from "./infrastructure/logging/logger.js";
import { InMemoryRepository } from "./infrastructure/persistence/in-memory-repository.js";
import { createApplicationServer } from "./presentation/api/server.js";

export function startApplication(): void {
  const config = loadConfig();
  const logger = new ConsoleLogger();
  const repository = new InMemoryRepository();
  const server = createApplicationServer(config, repository, logger);

  server.listen(config.port, "0.0.0.0", () => {
    logger.info("SupaScraper application is listening.", {
      port: config.port,
      collectorConfigured: config.collector !== null,
      geminiEnabled: config.geminiEnabled,
    });
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  startApplication();
}
