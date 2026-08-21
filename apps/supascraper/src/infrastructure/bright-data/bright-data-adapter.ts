import type {
  CollectorApprover,
  CollectorHealer,
  HealEnvelope,
} from "../../application/heal-and-verify/heal-and-verify.js";
import type { CollectorRunner } from "../../application/run-collector/run-collector.js";
import type {
  CollectorConfig,
  NormalizedRunResult,
} from "../../domain/contracts/collector-run.js";

export type BrightDataOperation = "run" | "heal" | "approve" | "reject";

export class BrightDataIntegrationNotConfiguredError extends Error {
  readonly operation: BrightDataOperation;

  constructor(operation: BrightDataOperation) {
    super(
      `Bright Data ${operation} integration is not configured. Complete the capability and manual vertical-slice phases before enabling it.`,
    );
    this.name = "BrightDataIntegrationNotConfiguredError";
    this.operation = operation;
  }
}

/**
 * Placeholder adapter that fails closed.
 *
 * It exists so no code path can silently fake a run or a repair before the live
 * CLI integration has been observed and verified. Every method rejects.
 */
export class UnconfiguredBrightDataAdapter
  implements CollectorRunner, CollectorHealer, CollectorApprover
{
  run(_config: CollectorConfig): Promise<NormalizedRunResult> {
    return Promise.reject(new BrightDataIntegrationNotConfiguredError("run"));
  }

  heal(_collectorId: string, _prompt: string): Promise<HealEnvelope> {
    return Promise.reject(new BrightDataIntegrationNotConfiguredError("heal"));
  }

  approve(_collectorId: string): Promise<void> {
    return Promise.reject(new BrightDataIntegrationNotConfiguredError("approve"));
  }

  reject(_collectorId: string): Promise<void> {
    return Promise.reject(new BrightDataIntegrationNotConfiguredError("reject"));
  }
}
