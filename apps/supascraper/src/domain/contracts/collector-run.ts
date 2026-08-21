export type CollectorRunStatus = "succeeded" | "failed" | "timed_out";

export interface CollectorConfig {
  readonly collectorId: string;
  readonly targetUrl: string;
  readonly fieldDescription: string;
  readonly timeoutMs: number;
}

export interface SafeRunError {
  readonly category: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface NormalizedRunResult {
  readonly collectorId: string;
  readonly targetUrl: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: CollectorRunStatus;
  readonly records: readonly unknown[];
  readonly snapshotId: string | null;
  readonly safeError: SafeRunError | null;
}
