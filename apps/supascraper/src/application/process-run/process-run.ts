import { randomUUID } from "node:crypto";

import type { ScrapedRecord } from "@supascraper/shared";

import {
  BOOTSTRAP_CONTRACT,
  evaluateContract,
  profileContract,
  type ContractEvaluation,
  type DataContract,
} from "../../domain/contracts/data-contract.js";
import type {
  CollectorConfig,
  NormalizedRunResult,
} from "../../domain/contracts/collector-run.js";
import {
  classifyRun,
  type DetectionDecision,
} from "../../domain/detection/classify-run.js";
import { buildHealPrompt } from "../../domain/repair/heal-prompt.js";
import type { GeminiReasoner } from "../../infrastructure/gemini/gemini-adapter.js";
import { mergeReasoning } from "../../infrastructure/gemini/gemini-adapter.js";
import type { RepairEvent, VerificationStatus } from "../../domain/repair/repair-event.js";
import type { OrchestrationState } from "../../domain/state-machine/state-machine.js";
import type {
  HealAndVerifyDependencies,
  HealAndVerifyOutcome,
} from "../heal-and-verify/heal-and-verify.js";
import { healAndVerify } from "../heal-and-verify/heal-and-verify.js";

export interface ScrapedDataStore {
  saveLastKnownGood(
    collectorId: string,
    records: readonly ScrapedRecord[],
    collectedAt: string,
  ): Promise<void>;
  getLastKnownGood(
    collectorId: string,
  ): Promise<{ readonly records: readonly ScrapedRecord[] } | null>;
  /** Null until a run has been good enough to learn a contract from. */
  getContract(collectorId: string): Promise<DataContract | null>;
  saveContract(collectorId: string, contract: DataContract): Promise<void>;
}

export interface RepairEventStore {
  appendEvent(event: RepairEvent): Promise<void>;
}

export interface ProcessRunResult {
  readonly decision: DetectionDecision;
  readonly evaluation: ContractEvaluation;
  readonly published: boolean;
  readonly repair: HealAndVerifyOutcome | null;
  readonly state: OrchestrationState;
  /** The contract this run was judged against. */
  readonly contract: DataContract;
  /** True when this run taught the system what the site's data looks like. */
  readonly contractLearned: boolean;
}

/**
 * Minimum confidence before a repair may be attempted without a human.
 *
 * Deterministic structural detection reports 0.9 or above, so this admits a
 * confident break while still refusing anything the detector is unsure about.
 */
export const AUTO_HEAL_CONFIDENCE_THRESHOLD = 0.85;

export interface ProcessRunOptions {
  /** Off by default: healing mutates a hosted collector and spends credit. */
  readonly autoHealEnabled?: boolean;
  readonly config?: CollectorConfig;
  readonly repair?: HealAndVerifyDependencies;
  /** Optional second opinion. Never required, never able to widen permission. */
  readonly reasoner?: GeminiReasoner;
}

/**
 * Gemini is consulted only where a second opinion could change what happens.
 *
 * A routine healthy run needs no judgement, and spending quota on non-decisions
 * would be waste.
 */
export function shouldConsultReasoner(decision: DetectionDecision): boolean {
  return (
    decision.classification === "ambiguous" ||
    decision.classification === "structural_break"
  );
}

function stateFor(
  decision: DetectionDecision,
  published: boolean,
  repair: HealAndVerifyOutcome | null,
): OrchestrationState {
  if (repair !== null) {
    return repair.finalState;
  }
  if (published) {
    return "healthy";
  }
  switch (decision.recommendedAction) {
    case "retry":
      return "retry_or_wait";
    case "manual_review":
      return "manual_review";
    default:
      return "suspected";
  }
}

/**
 * Processes one collector run: validate, classify, publish or withhold, and
 * optionally drive an automatic repair.
 *
 * Publication is gated on the contract, never on the command succeeding, and a
 * repair is only attempted for a confident structural break.
 */
export async function processCollectorRun(
  run: NormalizedRunResult,
  dataStore: ScrapedDataStore,
  eventStore: RepairEventStore,
  options: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  // A site the system has never scraped successfully has no contract yet, so it
  // is judged against the universal minimum until a good run can teach it one.
  const stored = await dataStore.getContract(run.collectorId);
  const contract = stored ?? BOOTSTRAP_CONTRACT;
  const evaluation = evaluateContract(run.records, contract);

  // The previously verified data is the only reference that can distinguish a
  // real data change from a partially broken extraction.
  const previous = await dataStore.getLastKnownGood(run.collectorId);
  const deterministic = classifyRun(
    run,
    evaluation,
    previous?.records ?? null,
    contract,
  );

  let decision = deterministic;
  if (options.reasoner !== undefined && shouldConsultReasoner(deterministic)) {
    const opinion = await options.reasoner.reason({
      fieldDescription: options.config?.fieldDescription ?? "",
      run,
      evaluation,
      deterministic,
    });
    decision = mergeReasoning(deterministic, opinion);
  }

  const publishable =
    decision.recommendedAction === "publish" && evaluation.valid && run.records.length > 0;

  let learnedContract: DataContract | null = null;

  if (publishable) {
    await dataStore.saveLastKnownGood(
      run.collectorId,
      evaluation.acceptedRecords,
      run.finishedAt,
    );

    // First good run for this site: derive the contract that every later run
    // will be held to. Learning it here, from data a human can see on the
    // dashboard, is what allows an arbitrary site to be monitored at all.
    if (stored === null) {
      learnedContract = profileContract(evaluation.acceptedRecords);
      await dataStore.saveContract(run.collectorId, learnedContract);
    }
  }

  let repair: HealAndVerifyOutcome | null = null;
  let healPrompt: string | null = null;

  const mayHeal =
    options.autoHealEnabled === true &&
    options.config !== undefined &&
    options.repair !== undefined &&
    decision.classification === "structural_break" &&
    decision.recommendedAction === "heal" &&
    decision.confidence >= AUTO_HEAL_CONFIDENCE_THRESHOLD;

  if (mayHeal && options.config && options.repair) {
    healPrompt = buildHealPrompt({
      fieldDescription: options.config.fieldDescription,
      run,
      evaluation,
    });

    repair = await healAndVerify(
      {
        config: options.config,
        decision,
        healPrompt,
        contract,
        ...(previous === null ? {} : { baseline: previous.records }),
      },
      options.repair,
    );
  }

  const published = publishable || repair?.status === "recovered";
  const state = stateFor(decision, publishable, repair);

  const verification: VerificationStatus =
    repair === null
      ? "not_started"
      : repair.status === "recovered"
        ? "passed"
        : "failed";

  const afterMetrics =
    repair?.verificationRun === null || repair?.verificationRun === undefined
      ? null
      : evaluateContract(repair.verificationRun.records, contract).metrics;

  const now = new Date().toISOString();
  await eventStore.appendEvent({
    id: randomUUID(),
    collectorId: run.collectorId,
    targetUrl: run.targetUrl,
    state,
    classification: decision.classification,
    confidence: decision.confidence,
    evidence: repair === null ? decision.evidence : [...decision.evidence, repair.reason],
    beforeMetrics: evaluation.metrics,
    afterMetrics,
    healPrompt,
    commandOutcome: repair?.envelope?.status ?? null,
    verification,
    createdAt: now,
    updatedAt: now,
  });

  return {
    decision,
    evaluation,
    published,
    repair,
    state,
    contract: learnedContract ?? contract,
    contractLearned: learnedContract !== null,
  };
}
