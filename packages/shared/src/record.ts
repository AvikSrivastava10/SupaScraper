/** A scraped row. Field names depend on the site, so nothing is assumed. */
export type ScrapedRecord = Record<string, unknown>;

export type FieldType = "string" | "number" | "boolean";

/**
 * Keys Bright Data adds around the extracted data.
 *
 * These describe the run rather than the page, so they are excluded when a
 * contract is profiled. Counting them as data would make every contract look
 * satisfied even when the real fields went missing.
 */
export const VENDOR_FIELDS: readonly string[] = [
  "input",
  "error",
  "error_code",
  "warning",
  "timestamp",
  "snapshot_id",
];

export function isVendorField(name: string): boolean {
  return VENDOR_FIELDS.includes(name);
}

/** Field names that usually identify a row, best first. */
export const IDENTITY_HINTS: readonly string[] = [
  "sku",
  "upc",
  "id",
  "code",
  "isbn",
  "part_number",
  "partnumber",
  "slug",
  "url",
];
