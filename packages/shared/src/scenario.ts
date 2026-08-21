export const SCENARIO_MODES = [
  "baseline",
  "legitimate_change",
  "structural_break",
  "transient_error",
] as const;

export type ScenarioMode = (typeof SCENARIO_MODES)[number];
export type ScenarioControlAction = ScenarioMode | "reset";

export function isScenarioMode(value: unknown): value is ScenarioMode {
  return (
    typeof value === "string" &&
    (SCENARIO_MODES as readonly string[]).includes(value)
  );
}

export function isScenarioControlAction(
  value: unknown,
): value is ScenarioControlAction {
  return value === "reset" || isScenarioMode(value);
}
