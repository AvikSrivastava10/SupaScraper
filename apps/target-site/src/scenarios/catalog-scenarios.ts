import type { CatalogRecord, ScenarioMode } from "@supascraper/shared";

import { BASELINE_CATALOG, CHANGED_CATALOG } from "../catalog/catalog-data.js";

export function recordsForScenario(
  scenario: ScenarioMode,
): readonly CatalogRecord[] {
  return scenario === "legitimate_change"
    ? CHANGED_CATALOG
    : BASELINE_CATALOG;
}
