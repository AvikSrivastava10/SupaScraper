import type { ScrapedRecord } from "@supascraper/shared";

import { fieldsInRecords } from "../../domain/contracts/data-contract.js";

export const EXPORT_FORMATS = [
  "json",
  "jsonl",
  "csv",
  "tsv",
  "xml",
  "md",
  "html",
] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value);
}

export interface ExportResult {
  readonly contentType: string;
  readonly fileName: string;
  readonly body: string;
}

export interface ExportOptions {
  readonly format: ExportFormat;
  /** Used for the download file name. */
  readonly name: string;
  /** Overrides column order. Defaults to every field the rows contain. */
  readonly columns?: readonly string[];
  readonly collectedAt?: string | null;
}

const CONTENT_TYPES: Readonly<Record<ExportFormat, string>> = {
  json: "application/json; charset=utf-8",
  jsonl: "application/x-ndjson; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  tsv: "text/tab-separated-values; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
};

export const EXPORT_LABELS: Readonly<Record<ExportFormat, string>> = {
  json: "JSON",
  jsonl: "JSON Lines",
  csv: "CSV",
  tsv: "TSV",
  xml: "XML",
  md: "Markdown",
  html: "HTML",
};

function textOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Characters that make a spreadsheet treat a cell as a formula.
 *
 * The data comes from third-party pages, so a cell could arrive holding
 * something like `=HYPERLINK(...)`. Opening the export would then execute it.
 */
const FORMULA_LEAD = /^[=+@\t\r]/;

/**
 * Neutralises a spreadsheet formula without corrupting real data.
 *
 * A blanket prefix would break legitimate negative numbers, so `-` is only
 * guarded when the value is not numeric.
 */
function guardFormula(text: string): string {
  if (FORMULA_LEAD.test(text)) {
    return `'${text}`;
  }
  if (text.startsWith("-") && !Number.isFinite(Number(text))) {
    return `'${text}`;
  }
  return text;
}

/** RFC 4180 quoting. */
function csvCell(value: unknown): string {
  const text = guardFormula(textOf(value));
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** TSV has no quoting, so separators inside a value are replaced. */
function tsvCell(value: unknown): string {
  return guardFormula(textOf(value)).replaceAll(/[\t\r\n]+/g, " ");
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function escapeXml(value: string): string {
  return value
    // Control characters are illegal in XML 1.0 and would make the file unusable.
    .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replaceAll(/[&<>"']/g, (character) => XML_ENTITIES[character] ?? character);
}

function escapeHtml(value: string): string {
  return value.replaceAll(/[&<>"']/g, (character) => XML_ENTITIES[character] ?? character);
}

/** Pipes and newlines would otherwise break out of a Markdown table cell. */
function markdownCell(value: unknown): string {
  return textOf(value)
    .replaceAll("|", "\\|")
    .replaceAll(/[\r\n]+/g, " ");
}

function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 60) : "supascraper";
}

function renderCsv(
  records: readonly ScrapedRecord[],
  columns: readonly string[],
  delimiter: string,
  cell: (value: unknown) => string,
): string {
  const lines = [columns.map((column) => cell(column)).join(delimiter)];
  for (const record of records) {
    lines.push(columns.map((column) => cell(record[column])).join(delimiter));
  }
  // CRLF is what RFC 4180 specifies and what Excel expects.
  return lines.join("\r\n");
}

function renderXml(
  records: readonly ScrapedRecord[],
  columns: readonly string[],
  name: string,
  collectedAt: string | null,
): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<dataset name="${escapeXml(name)}"${
      collectedAt === null ? "" : ` collectedAt="${escapeXml(collectedAt)}"`
    } count="${String(records.length)}">`,
  ];

  for (const record of records) {
    lines.push("  <record>");
    for (const column of columns) {
      // Field names come from the scraped site and need not be valid XML names,
      // so the name is carried as an attribute rather than as the element name.
      lines.push(
        `    <field name="${escapeXml(column)}">${escapeXml(textOf(record[column]))}</field>`,
      );
    }
    lines.push("  </record>");
  }

  lines.push("</dataset>");
  return lines.join("\n");
}

function renderMarkdown(
  records: readonly ScrapedRecord[],
  columns: readonly string[],
  name: string,
  collectedAt: string | null,
): string {
  const lines = [
    `# ${name}`,
    "",
    collectedAt === null
      ? `${String(records.length)} record(s).`
      : `${String(records.length)} record(s), last verified ${collectedAt}.`,
    "",
  ];

  if (columns.length === 0) {
    lines.push("_No data._");
    return lines.join("\n");
  }

  lines.push(`| ${columns.map((column) => markdownCell(column)).join(" | ")} |`);
  lines.push(`| ${columns.map(() => "---").join(" | ")} |`);
  for (const record of records) {
    lines.push(`| ${columns.map((column) => markdownCell(record[column])).join(" | ")} |`);
  }
  return lines.join("\n");
}

function renderHtml(
  records: readonly ScrapedRecord[],
  columns: readonly string[],
  name: string,
  collectedAt: string | null,
): string {
  const head = columns
    .map((column) => `<th scope="col">${escapeHtml(column)}</th>`)
    .join("");
  const body = records
    .map(
      (record) =>
        `<tr>${columns
          .map((column) => `<td>${escapeHtml(textOf(record[column]))}</td>`)
          .join("")}</tr>`,
    )
    .join("\n      ");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(name)}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 2rem; }
      table { border-collapse: collapse; }
      th, td { border: 1px solid #ccc; padding: .4rem .6rem; text-align: left; }
      caption { text-align: left; padding-bottom: .5rem; color: #555; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(name)}</h1>
    <table>
      <caption>${String(records.length)} record(s)${
        collectedAt === null ? "" : `, last verified ${escapeHtml(collectedAt)}`
      }.</caption>
      <thead><tr>${head}</tr></thead>
      <tbody>
      ${body}
      </tbody>
    </table>
  </body>
</html>`;
}

/**
 * Serialises verified rows into a downloadable document.
 *
 * Field names are never assumed: columns are derived from the rows themselves,
 * so any site's data exports without configuration.
 */
export function exportRecords(
  records: readonly ScrapedRecord[],
  options: ExportOptions,
): ExportResult {
  const columns = options.columns ?? fieldsInRecords(records);
  const collectedAt = options.collectedAt ?? null;
  const stamp = new Date().toISOString().slice(0, 10);
  const fileName = `${slug(options.name)}-${stamp}.${options.format}`;

  const body = ((): string => {
    switch (options.format) {
      case "json":
        return JSON.stringify(records, null, 2);
      case "jsonl":
        return records.map((record) => JSON.stringify(record)).join("\n");
      case "csv":
        return renderCsv(records, columns, ",", csvCell);
      case "tsv":
        return renderCsv(records, columns, "\t", tsvCell);
      case "xml":
        return renderXml(records, columns, options.name, collectedAt);
      case "md":
        return renderMarkdown(records, columns, options.name, collectedAt);
      case "html":
        return renderHtml(records, columns, options.name, collectedAt);
    }
  })();

  return { contentType: CONTENT_TYPES[options.format], fileName, body };
}
