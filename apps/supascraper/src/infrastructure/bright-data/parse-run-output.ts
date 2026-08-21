import type {
  ExtractionError,
  ExtractionErrorKind,
} from "../../domain/contracts/collector-run.js";

export interface ParsedRunOutput {
  readonly records: readonly unknown[];
  readonly extractionErrors: readonly ExtractionError[];
}

export class UnparseableRunOutputError extends Error {
  constructor(reason: string) {
    super(`Collector output could not be parsed: ${reason}`);
    this.name = "UnparseableRunOutputError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Classifies a per-row error message observed in real Bright Data output.
 *
 * Both observed forms matter, and conflating them would be dangerous: a dead
 * page must never trigger a heal, while a selector timeout is exactly what
 * should.
 */
export function classifyExtractionError(
  message: string,
  code: string | null,
): ExtractionErrorKind {
  const normalized = message.toLowerCase();

  if (code === "dead_page" || normalized.includes("dead page")) {
    return "unreachable_page";
  }
  if (normalized.includes("waiting for selector") || normalized.includes("timeout")) {
    return "selector_timeout";
  }
  return "unknown";
}

/**
 * Splits a collector run payload into data rows and per-row extraction errors.
 *
 * Bright Data emits a JSON array where a failed input appears as an object with
 * an `error` field instead of the extracted fields. Treating those as data would
 * make an entirely failed run look like a schema violation, which would in turn
 * mask the real cause.
 */
export function parseRunOutput(raw: string): ParsedRunOutput {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new UnparseableRunOutputError("output was empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new UnparseableRunOutputError("output was not valid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new UnparseableRunOutputError("expected a JSON array of rows");
  }

  const records: unknown[] = [];
  const extractionErrors: ExtractionError[] = [];

  for (const row of parsed) {
    if (isRecord(row) && typeof row["error"] === "string") {
      const message = row["error"];
      const code = typeof row["error_code"] === "string" ? row["error_code"] : null;
      extractionErrors.push({
        message,
        code,
        kind: classifyExtractionError(message, code),
      });
      continue;
    }
    records.push(row);
  }

  return { records, extractionErrors };
}
