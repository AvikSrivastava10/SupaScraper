import type { CatalogDataStore } from "../process-run/process-run.js";
import { evaluateCatalogContract } from "../../domain/contracts/catalog-contract.js";
import type {
  CollectorConfig,
  NormalizedRunResult,
} from "../../domain/contracts/collector-run.js";
import type { DetectionDecision } from "../../domain/detection/classify-run.js";
import type { CollectorRunner } from "../run-collector/run-collector.js";

export interface HealCommandOutcome {
  readonly completed: boolean;
  readonly safeMessage: string;
}

export interface CollectorHealer {
  heal(collectorId: string, prompt: string): Promise<HealCommandOutcome>;
}

export interface CollectorLock {
  acquire(collectorId: string): Promise<string | null>;
  release(collectorId: string, token: string): Promise<void>;
}

export interface HealAndVerifyInput {
  readonly config: CollectorConfig;
  readonly decision: DetectionDecision;
  readonly healPrompt: string;
}

export interface HealAndVerifyOutcome {
  readonly status: "recovered" | "manual_review" | "already_in_progress";
  readonly commandOutcome: HealCommandOutcome | null;
  readonly verificationRun: NormalizedRunResult | null;
}

export async function healAndVerify(
  input: HealAndVerifyInput,
  healer: CollectorHealer,
  runner: CollectorRunner,
  dataStore: CatalogDataStore,
  lock: CollectorLock,
): Promise<HealAndVerifyOutcome> {
  if (
    input.decision.classification !== "structural_break" ||
    input.decision.recommendedAction !== "heal"
  ) {
    throw new Error("Only a confirmed structural break may enter healing.");
  }

  const lockToken = await lock.acquire(input.config.collectorId);
  if (lockToken === null) {
    return {
      status: "already_in_progress",
      commandOutcome: null,
      verificationRun: null,
    };
  }

  try {
    const commandOutcome = await healer.heal(
      input.config.collectorId,
      input.healPrompt,
    );

    if (!commandOutcome.completed) {
      return {
        status: "manual_review",
        commandOutcome,
        verificationRun: null,
      };
    }

    const verificationRun = await runner.run(input.config);
    const evaluation = evaluateCatalogContract(verificationRun.records);
    const sameCollector =
      verificationRun.collectorId === input.config.collectorId &&
      verificationRun.targetUrl === input.config.targetUrl;

    if (verificationRun.status !== "succeeded" || !evaluation.valid || !sameCollector) {
      return {
        status: "manual_review",
        commandOutcome,
        verificationRun,
      };
    }

    await dataStore.saveLastKnownGood(
      input.config.collectorId,
      evaluation.acceptedRecords,
      verificationRun.finishedAt,
    );

    return {
      status: "recovered",
      commandOutcome,
      verificationRun,
    };
  } finally {
    await lock.release(input.config.collectorId, lockToken);
  }
}
