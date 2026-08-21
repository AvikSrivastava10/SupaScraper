import type {
  CollectorHealer,
  HealCommandOutcome,
} from "../../application/heal-and-verify/heal-and-verify.js";
import type { CollectorRunner } from "../../application/run-collector/run-collector.js";
import type {
  CollectorConfig,
  NormalizedRunResult,
} from "../../domain/contracts/collector-run.js";

export class BrightDataIntegrationNotConfiguredError extends Error {
  constructor(operation: "run" | "heal") {
    super(
      `Bright Data ${operation} integration is not configured. Complete the capability and manual vertical-slice phases before enabling it.`,
    );
    this.name = "BrightDataIntegrationNotConfiguredError";
  }
}

export class UnconfiguredBrightDataAdapter
  implements CollectorRunner, CollectorHealer
{
  run(_config: CollectorConfig): Promise<NormalizedRunResult> {
    return Promise.reject(new BrightDataIntegrationNotConfiguredError("run"));
  }

  heal(_collectorId: string, _prompt: string): Promise<HealCommandOutcome> {
    return Promise.reject(new BrightDataIntegrationNotConfiguredError("heal"));
  }
}
