export type OrchestrationState =
  | "idle"
  | "running"
  | "healthy"
  | "suspected"
  | "retry_or_wait"
  | "healing"
  | "verifying"
  | "recovered"
  | "manual_review";

const ALLOWED_TRANSITIONS: Readonly<
  Record<OrchestrationState, readonly OrchestrationState[]>
> = {
  idle: ["running"],
  running: ["healthy", "suspected", "retry_or_wait", "manual_review"],
  healthy: ["running", "suspected"],
  suspected: ["healthy", "retry_or_wait", "healing", "manual_review"],
  retry_or_wait: ["running", "manual_review"],
  healing: ["verifying", "manual_review"],
  verifying: ["recovered", "manual_review"],
  recovered: ["healthy", "running"],
  manual_review: ["idle", "running"],
};

export function canTransition(
  current: OrchestrationState,
  next: OrchestrationState,
): boolean {
  return ALLOWED_TRANSITIONS[current].includes(next);
}

export function transitionState(
  current: OrchestrationState,
  next: OrchestrationState,
): OrchestrationState {
  if (!canTransition(current, next)) {
    throw new Error(`Illegal orchestration transition: ${current} -> ${next}.`);
  }

  return next;
}
