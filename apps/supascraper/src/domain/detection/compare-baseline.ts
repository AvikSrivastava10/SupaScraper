import type { CatalogRecord } from "@supascraper/shared";

export interface FieldChange {
  readonly sku: string;
  readonly field: "name" | "price" | "availability";
  readonly before: string | number;
  readonly after: string | number;
}

export interface CatalogDiff {
  readonly changes: readonly FieldChange[];
  readonly addedSkus: readonly string[];
  readonly removedSkus: readonly string[];
  readonly hasChanges: boolean;
}

function index(records: readonly CatalogRecord[]): Map<string, CatalogRecord> {
  const byKey = new Map<string, CatalogRecord>();
  for (const record of records) {
    byKey.set(record.sku, record);
  }
  return byKey;
}

/**
 * Compares a valid run against the last verified data.
 *
 * This is what separates "the site's numbers moved" from "our extraction
 * broke". Both can look like a schema-valid run, and only a comparison against
 * history can tell them apart.
 */
export function compareToBaseline(
  baseline: readonly CatalogRecord[],
  current: readonly CatalogRecord[],
): CatalogDiff {
  const before = index(baseline);
  const after = index(current);

  const changes: FieldChange[] = [];
  const addedSkus: string[] = [];
  const removedSkus: string[] = [];

  for (const [sku, record] of after) {
    const previous = before.get(sku);
    if (!previous) {
      addedSkus.push(sku);
      continue;
    }
    if (previous.name !== record.name) {
      changes.push({ sku, field: "name", before: previous.name, after: record.name });
    }
    if (previous.price !== record.price) {
      changes.push({ sku, field: "price", before: previous.price, after: record.price });
    }
    if (previous.availability !== record.availability) {
      changes.push({
        sku,
        field: "availability",
        before: previous.availability,
        after: record.availability,
      });
    }
  }

  for (const sku of before.keys()) {
    if (!after.has(sku)) {
      removedSkus.push(sku);
    }
  }

  return {
    changes,
    addedSkus: addedSkus.sort(),
    removedSkus: removedSkus.sort(),
    hasChanges: changes.length > 0 || addedSkus.length > 0 || removedSkus.length > 0,
  };
}

/** Human-readable evidence lines, capped so a large diff stays readable. */
export function describeDiff(diff: CatalogDiff, limit = 3): string[] {
  const lines = diff.changes
    .slice(0, limit)
    .map(
      (change) =>
        `${change.sku} ${change.field}: ${String(change.before)} to ${String(change.after)}`,
    );

  if (diff.changes.length > limit) {
    lines.push(`and ${String(diff.changes.length - limit)} more field change(s)`);
  }
  if (diff.addedSkus.length > 0) {
    lines.push(`new: ${diff.addedSkus.join(", ")}`);
  }
  if (diff.removedSkus.length > 0) {
    lines.push(`missing: ${diff.removedSkus.join(", ")}`);
  }
  return lines;
}
