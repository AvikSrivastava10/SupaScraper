import type { CatalogFieldName } from "../contracts/catalog-contract.js";
import { CATALOG_FIELD_NAMES } from "@supascraper/shared";
import type { ContractEvaluation } from "../contracts/catalog-contract.js";
import type { NormalizedRunResult } from "../contracts/collector-run.js";

/** Verified limit for `scraper heal` in CLI 0.3.5. */
export const MAX_HEAL_PROMPT_LENGTH = 1000;

export interface HealPromptInput {
  readonly fieldDescription: string;
  readonly run: NormalizedRunResult;
  readonly evaluation: ContractEvaluation;
}

function affectedFields(evaluation: ContractEvaluation): CatalogFieldName[] {
  const affected = new Set<CatalogFieldName>();
  for (const violation of evaluation.violations) {
    for (const field of CATALOG_FIELD_NAMES) {
      if (violation.path.endsWith(`.${field}`) || violation.code.startsWith(field)) {
        affected.add(field);
      }
    }
  }
  return [...affected];
}

function firstSelectorHint(run: NormalizedRunResult): string | null {
  for (const error of run.extractionErrors) {
    if (error.kind !== "selector_timeout") continue;
    // Report the selector the scraper waited for, since that is observed fact.
    const quoted = /"([^"]+)"/.exec(error.message);
    if (quoted?.[1] !== undefined) {
      return quoted[1];
    }
  }
  return null;
}

/**
 * Builds a heal prompt from observed evidence and the original field intent.
 *
 * It deliberately never invents a selector. Naming a target selector that no
 * evidence supports would steer the repair toward a guess, and the whole point
 * of describing intent in plain language is that Bright Data finds the markup.
 * A selector is only mentioned when the failure message itself reported one.
 */
export function buildHealPrompt(input: HealPromptInput): string {
  const parts: string[] = [];

  const waitedFor = firstSelectorHint(input.run);
  if (waitedFor !== null) {
    parts.push(
      `Extraction is failing because the scraper waits for ${waitedFor}, which the page no longer contains.`,
    );
  } else {
    const fields = affectedFields(input.evaluation);
    parts.push(
      fields.length > 0
        ? `Extraction is returning invalid values for: ${fields.join(", ")}.`
        : "Extraction is no longer returning the expected records.",
    );
  }

  parts.push(
    "The pages still load successfully and a human can still read the same information, but the markup has been restructured.",
  );
  parts.push(`Re-extract the data described here: ${input.fieldDescription}`);

  const prompt = parts.join(" ").replace(/\s+/g, " ").trim();
  return prompt.length > MAX_HEAL_PROMPT_LENGTH
    ? `${prompt.slice(0, MAX_HEAL_PROMPT_LENGTH - 3).trimEnd()}...`
    : prompt;
}
