import type { DetectionDecision } from "../../domain/detection/classify-run.js";

export interface ReasoningContext {
  readonly fieldDescription: string;
  readonly deterministicDecision: DetectionDecision;
  readonly safeSamples: readonly unknown[];
}

export interface ReasoningResult {
  readonly decision: DetectionDecision;
  readonly explanation: string;
  readonly healPrompt: string | null;
}

export interface GeminiReasoner {
  reason(context: ReasoningContext): Promise<ReasoningResult | null>;
}

export class DisabledGeminiReasoner implements GeminiReasoner {
  reason(_context: ReasoningContext): Promise<null> {
    return Promise.resolve(null);
  }
}
