import type { ContractMetrics } from "../contracts/catalog-contract.js";
import type { DetectionClassification } from "../detection/classify-run.js";
import type { OrchestrationState } from "../state-machine/state-machine.js";

export type VerificationStatus = "not_started" | "passed" | "failed";

export interface RepairEvent {
  readonly id: string;
  readonly collectorId: string;
  readonly targetUrl: string;
  readonly state: OrchestrationState;
  readonly classification: DetectionClassification;
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly beforeMetrics: ContractMetrics;
  readonly afterMetrics: ContractMetrics | null;
  readonly healPrompt: string | null;
  readonly commandOutcome: string | null;
  readonly verification: VerificationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}
