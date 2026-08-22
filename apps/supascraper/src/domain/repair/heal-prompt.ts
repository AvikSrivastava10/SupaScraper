import type { ContractEvaluation } from "../contracts/data-contract.js";
import type { NormalizedRunResult } from "../contracts/collector-run.js";

/** Verified limit for `scraper heal` in CLI 0.3.5. */
export const MAX_HEAL_PROMPT_LENGTH = 1000;

export interface HealPromptInput {
  readonly fieldDescription: string;
  readonly run: NormalizedRunResult;
  readonly evaluation: ContractEvaluation;
}

/** Field names are site-defined, so only plain identifier-like names are relayed. */
const SAFE_FIELD_NAME = /^[A-Za-z0-9_\-. ]{1,40}$/;

const MAX_REPORTED_FIELDS = 8;

/**
 * Names the fields a failing run could not produce, read from violation paths.
 *
 * Deriving them from the evaluation rather than from a fixed field list is what
 * lets the same prompt builder serve any site.
 */
function affectedFields(evaluation: ContractEvaluation): string[] {
  const affected = new Set<string>();
  for (const violation of evaluation.violations) {
    const separator = violation.path.lastIndexOf(".");
    if (separator === -1) continue;
    const field = violation.path.slice(separator + 1);
    if (SAFE_FIELD_NAME.test(field)) {
      affected.add(field);
    }
  }
  return [...affected].slice(0, MAX_REPORTED_FIELDS);
}

/** Characters a CSS or XPath selector may contain. */
const SELECTOR_CHARSET = /^[A-Za-z0-9\s.#\-_[\]="'():>~*+/@|]{1,80}$/;

/** At least one of these must appear, or the value must be a single token. */
const SELECTOR_SYNTAX = /[.#[\]=:>~*+/@|]/;

/**
 * Extracts the selector a failing run reported, if it plausibly is one.
 *
 * The message originates outside this process, and it is forwarded into a prompt
 * consumed by Bright Data's AI. It cannot inject a shell command, because
 * arguments are passed as an array, but unbounded external text should not be
 * relayed into someone else's model either. Anything that does not look like a
 * selector is dropped rather than sanitized into something misleading.
 */
function firstSelectorHint(run: NormalizedRunResult): string | null {
  for (const error of run.extractionErrors) {
    if (error.kind !== "selector_timeout") continue;

    const quoted = /"([^"]+)"/.exec(error.message);
    const candidate = quoted?.[1];
    if (candidate === undefined) continue;

    const collapsed = candidate.replace(/\s+/g, " ").trim();
    if (!SELECTOR_CHARSET.test(collapsed)) continue;

    // Prose passes a charset check, so require selector syntax or a bare tag.
    const looksLikeSelector =
      SELECTOR_SYNTAX.test(collapsed) || !collapsed.includes(" ");
    if (looksLikeSelector) {
      return collapsed;
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
