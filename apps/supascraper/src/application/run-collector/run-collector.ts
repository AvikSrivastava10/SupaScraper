import type {
  CollectorConfig,
  NormalizedRunResult,
} from "../../domain/contracts/collector-run.js";

export interface CollectorRunner {
  run(config: CollectorConfig): Promise<NormalizedRunResult>;
}

export async function runCollector(
  config: CollectorConfig,
  runner: CollectorRunner,
): Promise<NormalizedRunResult> {
  if (!config.collectorId.startsWith("c_")) {
    throw new Error("Collector ID must start with c_.");
  }

  const parsedUrl = new URL(config.targetUrl);
  if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "localhost") {
    throw new Error("Collector target must use HTTPS unless it is localhost.");
  }

  return runner.run(config);
}
