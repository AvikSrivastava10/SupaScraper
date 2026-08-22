import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EXPORT_FORMATS,
  EXPORT_LABELS,
  exportRecords,
  isExportFormat,
} from "../dist/presentation/export/export-records.js";
import {
  orderedFields,
  profileContract,
} from "../dist/domain/contracts/data-contract.js";

const ROWS = [
  { sku: "MTR-100", name: "Precision Stepper Motor", price: 49.95, stocked: true },
  { sku: "RAIL-300", name: "Linear Rail 300mm", price: 18.4, stocked: false },
];

const exportAs = (format: string, records: readonly Record<string, unknown>[] = ROWS) =>
  exportRecords(records, { format: format as never, name: "Example shop" });

describe("export format registry", () => {
  it("recognizes exactly the formats it can produce", () => {
    for (const format of EXPORT_FORMATS) {
      assert.equal(isExportFormat(format), true, format);
      assert.ok(EXPORT_LABELS[format].length > 0, format);
    }
    for (const bogus of ["exe", "pdf", "", "JSON", "../etc/passwd"]) {
      assert.equal(isExportFormat(bogus), false, bogus);
    }
  });

  it("covers the formats a spreadsheet, a script, and a document each need", () => {
    assert.deepEqual([...EXPORT_FORMATS], [
      "json",
      "jsonl",
      "csv",
      "tsv",
      "xml",
      "md",
      "html",
    ]);
  });

  it("names the download after the site and the format", () => {
    const result = exportAs("csv");
    assert.match(result.fileName, /^example-shop-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("produces a filename even from a label with nothing usable in it", () => {
    const result = exportRecords(ROWS, { format: "json", name: "***" });
    assert.match(result.fileName, /^supascraper-/);
  });

  it("declares a content type for every format", () => {
    for (const format of EXPORT_FORMATS) {
      assert.match(exportAs(format).contentType, /charset=utf-8$/, format);
    }
  });
});

describe("JSON and JSON Lines export", () => {
  it("round-trips the rows exactly", () => {
    assert.deepEqual(JSON.parse(exportAs("json").body), ROWS);
  });

  it("writes one parseable object per line", () => {
    const lines = exportAs("jsonl").body.split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => JSON.parse(line)), ROWS);
  });

  it("handles an empty dataset without producing broken output", () => {
    assert.deepEqual(JSON.parse(exportRecords([], { format: "json", name: "x" }).body), []);
    assert.equal(exportRecords([], { format: "jsonl", name: "x" }).body, "");
  });
});

describe("CSV export", () => {
  it("writes a header row followed by the data", () => {
    const [header, ...rows] = exportAs("csv").body.split("\r\n");
    assert.equal(header, "sku,name,price,stocked");
    assert.equal(rows.length, 2);
    assert.match(rows[0] ?? "", /^MTR-100,Precision Stepper Motor,49\.95,true$/);
  });

  it("quotes a value containing the separator, a quote, or a newline", () => {
    const body = exportAs("csv", [
      { note: "a,b" },
      { note: 'say "hi"' },
      { note: "line one\nline two" },
    ]).body;
    assert.match(body, /"a,b"/);
    assert.match(body, /"say ""hi"""/);
    assert.match(body, /"line one\nline two"/);
  });

  it("renders an absent field as an empty cell rather than shifting columns", () => {
    const rows = [{ a: 1, b: 2 }, { a: 3 }];
    const body = exportRecords(rows, {
      format: "csv",
      name: "x",
      columns: ["a", "b"],
    }).body;
    assert.equal(body, "a,b\r\n1,2\r\n3,");
  });

  it("neutralises a value a spreadsheet would run as a formula", () => {
    // Values come from third-party pages, so an export opened in Excel must not
    // be able to execute what a page put in a cell.
    const body = exportAs("csv", [
      { v: "=HYPERLINK(\"http://evil.test\")" },
      { v: "+1+1" },
      { v: "@SUM(A1)" },
      { v: "-cmd|calc" },
    ]).body;

    for (const line of body.split("\r\n").slice(1)) {
      assert.match(line, /^'|^"'/, line);
    }
  });

  it("leaves a legitimate negative number alone", () => {
    const body = exportAs("csv", [{ delta: "-12.50" }, { delta: -3 }]).body;
    const rows = body.split("\r\n").slice(1);
    assert.equal(rows[0], "-12.50");
    assert.equal(rows[1], "-3");
  });
});

describe("TSV export", () => {
  it("separates with tabs", () => {
    const [header] = exportAs("tsv").body.split("\r\n");
    assert.equal(header, "sku\tname\tprice\tstocked");
  });

  it("replaces a tab or newline inside a value, since TSV cannot quote it", () => {
    const body = exportAs("tsv", [{ note: "a\tb\nc" }]).body;
    const row = body.split("\r\n")[1];
    assert.equal(row, "a b c");
  });
});

describe("XML export", () => {
  it("produces a declaration and one element per row", () => {
    const body = exportAs("xml").body;
    assert.match(body, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.equal(body.match(/<record>/g)?.length, 2);
    assert.match(body, /count="2"/);
  });

  it("carries the field name as an attribute, since a field name need not be a valid XML name", () => {
    const body = exportAs("xml", [{ "2nd choice": "x", "has space": "y" }]).body;
    assert.match(body, /<field name="2nd choice">x<\/field>/);
    assert.match(body, /<field name="has space">y<\/field>/);
  });

  it("escapes markup in both names and values", () => {
    const body = exportAs("xml", [{ "<bad>": '"quoted" & <tagged>' }]).body;
    assert.ok(!body.includes("<bad>"));
    assert.match(body, /&lt;bad&gt;/);
    assert.match(body, /&quot;quoted&quot; &amp; &lt;tagged&gt;/);
  });

  it("strips control characters that would make the document unparseable", () => {
    const body = exportAs("xml", [{ v: "a\u0000b\u0008c" }]).body;
    assert.match(body, /<field name="v">abc<\/field>/);
  });
});

describe("Markdown export", () => {
  it("writes a table with a separator row", () => {
    const lines = exportAs("md").body.split("\n");
    assert.ok(lines.some((line) => line.startsWith("| sku | name |")));
    assert.ok(lines.some((line) => /^\| --- \|/.test(line)));
  });

  it("escapes a pipe so it cannot break out of a cell", () => {
    const body = exportAs("md", [{ v: "a|b" }]).body;
    assert.match(body, /a\\\|b/);
  });

  it("says so plainly when there is nothing to tabulate", () => {
    assert.match(exportRecords([], { format: "md", name: "x" }).body, /_No data\._/);
  });
});

describe("HTML export", () => {
  it("produces a standalone document with a table", () => {
    const body = exportAs("html").body;
    assert.match(body, /^<!doctype html>/);
    assert.match(body, /<th scope="col">sku<\/th>/);
    assert.equal(body.match(/<tr>/g)?.length, 3, "one header row plus two data rows");
  });

  it("escapes values so an export cannot execute a page's script", () => {
    const body = exportAs("html", [{ v: "<script>alert(1)</script>" }]).body;
    assert.ok(!body.includes("<script>alert(1)</script>"));
    assert.match(body, /&lt;script&gt;/);
  });
});

describe("export column selection", () => {
  it("exports every field the rows contain, not only the required ones", () => {
    const rows = [
      { sku: "A", name: "first", discount: "10%" },
      { sku: "B", name: "second" },
    ];
    const contract = profileContract(rows);
    // The contract cannot require a field that only some rows had.
    assert.ok(!contract.requiredFields.includes("discount"));

    const columns = orderedFields(contract, rows);
    assert.ok(columns.includes("discount"), "an optional field must still export");
    assert.equal(columns[0], "sku", "identity leads, so the file is readable");

    const body = exportRecords(rows, { format: "csv", name: "x", columns }).body;
    assert.match(body, /^sku,name,discount/);
    assert.match(body, /10%/);
  });

  it("never exports the vendor fields Bright Data adds", () => {
    const rows = [{ name: "a", input: { url: "x" }, timestamp: "2026-01-01" }];
    const columns = orderedFields(profileContract(rows), rows);
    assert.deepEqual(columns, ["name"]);
  });

  it("keeps working when no contract has been learned", () => {
    const rows = [{ b: 2, a: 1 }];
    assert.deepEqual(orderedFields(null, rows), ["b", "a"]);
  });
});
