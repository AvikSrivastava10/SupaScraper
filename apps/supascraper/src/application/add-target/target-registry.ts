import type { TargetConfig } from "../../config/targets.js";

/**
 * A site that has been accepted but whose scraper does not exist yet.
 *
 * Bright Data's AI needs several minutes to build one, far longer than a request
 * should wait, so the site is registered immediately in this intermediate form
 * and appears on the dashboard while it is being built.
 */
export interface PendingTarget {
  readonly id: string;
  readonly label: string;
  readonly targetUrl: string;
  readonly fieldDescription: string;
  readonly requestedAt: string;
  readonly status: "building" | "failed";
  readonly message: string;
}

export interface TargetRegistry {
  /** Every target with a working collector, seeds first. */
  list(): readonly TargetConfig[];
  pending(): readonly PendingTarget[];
  get(id: string): TargetConfig | null;
  isTaken(id: string): boolean;
  /** True when this exact page is already registered or being built. */
  hasUrl(url: string): boolean;
  addPending(target: PendingTarget): void;
  /** Promotes a pending entry once its collector exists. */
  resolvePending(id: string, collectorId: string, timeoutMs: number): TargetConfig;
  failPending(id: string, message: string): void;
}
