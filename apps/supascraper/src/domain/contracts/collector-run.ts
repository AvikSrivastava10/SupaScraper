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

/**
 * How a per-row extraction failure should be interpreted.
 *
 * Bright Data returns these inside a successful run payload, one row per input
 * it could not extract, so the command exits cleanly while carrying failures.
 *
 * - `unreachable_page`: the page could not be loaded at all, for example a 404.
 *   Healing cannot fix a wrong or dead URL, so this must not trigger a repair.
 * - `proxy_error`: the request never left Bright Data's network, for example a
 *   407 from the proxy. The target site was never contacted, so neither the URL
 *   nor the scraper is implicated and repairing either would be wrong.
 * - `selector_timeout`: the page loaded but the extraction logic no longer
 *   matches it. This is the structural break the project exists to repair.
 */
export type ExtractionErrorKind =
  | "unreachable_page"
  | "proxy_error"
  | "selector_timeout"
  | "unknown";

export interface ExtractionError {
  readonly message: string;
  readonly code: string | null;
  readonly kind: ExtractionErrorKind;
}

export interface NormalizedRunResult {
  readonly collectorId: string;
  readonly targetUrl: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: CollectorRunStatus;
  /** Data rows only. Rows carrying an error are separated out. */
  readonly records: readonly unknown[];
  readonly extractionErrors: readonly ExtractionError[];
  readonly snapshotId: string | null;
  readonly safeError: SafeRunError | null;
}
