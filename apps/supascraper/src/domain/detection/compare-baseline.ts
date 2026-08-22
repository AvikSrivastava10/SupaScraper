import { isVendorField, type ScrapedRecord } from "@supascraper/shared";

import type { DataContract } from "../contracts/data-contract.js";

export interface FieldChange {
  /** Identity value of the row, or a readable label when there is no identity. */
  readonly key: string;
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface RecordDiff {
  readonly changes: readonly FieldChange[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly hasChanges: boolean;
}

function dataEntries(record: ScrapedRecord): [string, unknown][] {
  return Object.entries(record)
    .filter(([key]) => !isVendorField(key))
    .sort(([a], [b]) => a.localeCompare(b));
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object" && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function short(value: unknown, maxLength = 40): string {
  const text =
    typeof value === "object" && value !== null
      ? JSON.stringify(value)
      : String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * A readable stand-in for a row that has no identity field.
 *
 * Row numbers would be meaningless across runs, since ordering can change. The
 * first couple of real values are stable enough to recognise in a diff.
 */
export function rowLabel(record: ScrapedRecord): string {
  const values = dataEntries(record)
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "")
    .slice(0, 2)
    .map(([, value]) => short(value, 28));
  return values.length > 0 ? values.join(" · ") : "(empty row)";
}

/** Stable digest of a row's data, used when no identity field exists. */
export function rowFingerprint(record: ScrapedRecord): string {
  return JSON.stringify(dataEntries(record));
}

function indexByIdentity(
  records: readonly ScrapedRecord[],
  identityField: string,
): Map<string, ScrapedRecord> {
  const byKey = new Map<string, ScrapedRecord>();
  for (const record of records) {
    const identity = record[identityField];
    if (identity === null || identity === undefined) continue;
    byKey.set(String(identity), record);
  }
  return byKey;
}

/**
 * Compares a valid run against the last verified data.
 *
 * This is what separates "the site's values moved" from "our extraction broke".
 * Both can look like a contract-valid run, and only a comparison against history
 * can tell them apart.
 *
 * With an identity field the comparison is field-by-field per row. Without one,
 * rows can only be matched whole, so the diff reports appearances and
 * disappearances rather than edits.
 */
export function compareToBaseline(
  baseline: readonly ScrapedRecord[],
  current: readonly ScrapedRecord[],
  contract: DataContract | null = null,
): RecordDiff {
  const identityField = contract?.identityField ?? null;

  if (identityField === null) {
    const before = new Map<string, ScrapedRecord>();
    for (const record of baseline) {
      before.set(rowFingerprint(record), record);
    }
    const after = new Map<string, ScrapedRecord>();
    for (const record of current) {
      after.set(rowFingerprint(record), record);
    }

    const added = [...after.entries()]
      .filter(([print]) => !before.has(print))
      .map(([, record]) => rowLabel(record));
    const removed = [...before.entries()]
      .filter(([print]) => !after.has(print))
      .map(([, record]) => rowLabel(record));

    return {
      changes: [],
      added: added.sort(),
      removed: removed.sort(),
      hasChanges: added.length > 0 || removed.length > 0,
    };
  }

  const before = indexByIdentity(baseline, identityField);
  const after = indexByIdentity(current, identityField);

  const changes: FieldChange[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const [key, record] of after) {
    const previous = before.get(key);
    if (previous === undefined) {
      added.push(key);
      continue;
    }

    const fields = new Set([
      ...dataEntries(previous).map(([field]) => field),
      ...dataEntries(record).map(([field]) => field),
    ]);

    for (const field of [...fields].sort()) {
      if (field === identityField) continue;
      if (!sameValue(previous[field], record[field])) {
        changes.push({
          key,
          field,
          before: previous[field] ?? null,
          after: record[field] ?? null,
        });
      }
    }
  }

  for (const key of before.keys()) {
    if (!after.has(key)) {
      removed.push(key);
    }
  }

  return {
    changes,
    added: added.sort(),
    removed: removed.sort(),
    hasChanges: changes.length > 0 || added.length > 0 || removed.length > 0,
  };
}

/** Human-readable evidence lines, capped so a large diff stays readable. */
export function describeDiff(diff: RecordDiff, limit = 3): string[] {
  const lines = diff.changes
    .slice(0, limit)
    .map(
      (change) =>
        `${change.key} ${change.field}: ${short(change.before)} to ${short(change.after)}`,
    );

  if (diff.changes.length > limit) {
    lines.push(`and ${String(diff.changes.length - limit)} more field change(s)`);
  }
  if (diff.added.length > 0) {
    lines.push(
      diff.added.length > limit
        ? `${String(diff.added.length)} row(s) appeared`
        : `new: ${diff.added.join(", ")}`,
    );
  }
  if (diff.removed.length > 0) {
    lines.push(
      diff.removed.length > limit
        ? `${String(diff.removed.length)} row(s) disappeared`
        : `missing: ${diff.removed.join(", ")}`,
    );
  }
  return lines;
}
