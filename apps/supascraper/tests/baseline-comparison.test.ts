import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compareToBaseline,
  describeDiff,
  rowFingerprint,
  rowLabel,
} from "../dist/domain/detection/compare-baseline.js";
import { classifyRun } from "../dist/domain/detection/classify-run.js";
import {
  evaluateContract,
  profileContract,
} from "../dist/domain/contracts/data-contract.js";
import type { NormalizedRunResult } from "../dist/domain/contracts/collector-run.js";

const CATALOG = [
  { name: "Precision Stepper Motor", sku: "MTR-100", price: 49.95, availability: "in_stock" },
  { name: "Industrial Sensor Module", sku: "SNS-240", price: 84.5, availability: "low_stock" },
  { name: "Compact Control Relay", sku: "RLY-310", price: 29.75, availability: "out_of_stock" },
];

const CONTRACT = profileContract(CATALOG);

const run = (records: readonly unknown[]): NormalizedRunResult => ({
  collectorId: "c_test",
  targetUrl: "https://example.test/catalog",
  startedAt: "2026-08-21T00:00:00Z",
  finishedAt: "2026-08-21T00:00:05Z",
  status: "succeeded",
  records,
  extractionErrors: [],
  snapshotId: null,
  safeError: null,
});

const classify = (records: readonly unknown[], baseline: readonly unknown[] | null) =>
  classifyRun(
    run(records),
    evaluateContract(records, CONTRACT),
    baseline as never,
    CONTRACT,
  );

describe("compareToBaseline", () => {
  it("finds no changes for identical data", () => {
    const diff = compareToBaseline(
      CATALOG,
      CATALOG.map((record) => ({ ...record })),
      CONTRACT,
    );
    assert.equal(diff.hasChanges, false);
    assert.equal(diff.changes.length, 0);
  });

  it("detects a price change with before and after", () => {
    const changed = CATALOG.map((record) =>
      record.sku === "MTR-100" ? { ...record, price: 52.25 } : record,
    );
    const diff = compareToBaseline(CATALOG, changed, CONTRACT);
    assert.equal(diff.hasChanges, true);
    assert.equal(diff.changes.length, 1);
    assert.deepEqual(diff.changes[0], {
      key: "MTR-100",
      field: "price",
      before: 49.95,
      after: 52.25,
    });
  });

  it("detects several field changes on one row", () => {
    const changed = CATALOG.map((record) =>
      record.sku === "SNS-240"
        ? { ...record, availability: "in_stock", name: "Renamed Module" }
        : record,
    );
    const diff = compareToBaseline(CATALOG, changed, CONTRACT);
    const fields = diff.changes.map((change) => change.field).sort();
    assert.deepEqual(fields, ["availability", "name"]);
  });

  it("reports added and removed rows by identity", () => {
    const changed = [
      ...CATALOG.slice(1),
      { name: "New Widget", sku: "WDG-900", price: 12.5, availability: "in_stock" },
    ];
    const diff = compareToBaseline(CATALOG, changed, CONTRACT);
    assert.deepEqual(diff.added, ["WDG-900"]);
    assert.deepEqual(diff.removed, ["MTR-100"]);
    assert.equal(diff.hasChanges, true);
  });

  it("notices a field that appeared or vanished, not only one that changed", () => {
    const withExtra = CATALOG.map((record) => ({ ...record, colour: "black" }));
    const diff = compareToBaseline(CATALOG, withExtra, CONTRACT);
    assert.equal(diff.changes.length, 3);
    assert.ok(diff.changes.every((change) => change.field === "colour"));
  });

  it("summarizes a large diff without flooding the evidence", () => {
    const changed = CATALOG.map((record) => ({ ...record, price: record.price + 1 }));
    const lines = describeDiff(compareToBaseline(CATALOG, changed, CONTRACT), 2);
    assert.equal(lines.length, 3);
    assert.match(lines[2] ?? "", /1 more field change/);
  });
});

describe("compareToBaseline without an identity field", () => {
  const ROWS = [
    { tag: "alpha", group: "x" },
    { tag: "alpha", group: "x" },
  ];
  const NO_IDENTITY = profileContract(ROWS);

  it("has no identity to key on", () => {
    assert.equal(NO_IDENTITY.identityField, null);
  });

  it("still recognises identical data", () => {
    const diff = compareToBaseline(ROWS, [...ROWS], NO_IDENTITY);
    assert.equal(diff.hasChanges, false);
  });

  it("reports whole rows appearing and disappearing", () => {
    const diff = compareToBaseline(ROWS, [{ tag: "beta", group: "x" }], NO_IDENTITY);
    assert.equal(diff.hasChanges, true);
    assert.equal(diff.changes.length, 0);
    assert.equal(diff.added.length, 1);
    assert.equal(diff.removed.length, 1);
    assert.match(describeDiff(diff).join(" "), /beta/);
  });

  it("labels a row by its first values rather than by position", () => {
    assert.equal(rowLabel({ tag: "alpha", group: "x" }), "x · alpha");
    assert.equal(rowLabel({}), "(empty row)");
  });

  it("fingerprints identical rows identically, whatever the key order", () => {
    assert.equal(
      rowFingerprint({ a: 1, b: 2 }),
      rowFingerprint({ b: 2, a: 1 }),
    );
    assert.notEqual(rowFingerprint({ a: 1 }), rowFingerprint({ a: 2 }));
  });

  it("ignores vendor fields when fingerprinting, so a timestamp is not a change", () => {
    assert.equal(
      rowFingerprint({ a: 1, timestamp: "2026-01-01" }),
      rowFingerprint({ a: 1, timestamp: "2026-06-30" }),
    );
  });
});

describe("classifyRun with a baseline", () => {
  it("calls an unchanged valid run healthy", () => {
    const decision = classify(CATALOG, CATALOG);
    assert.equal(decision.classification, "healthy");
    assert.equal(decision.recommendedAction, "publish");
    assert.ok(decision.evidence.some((line) => /no change/i.test(line)));
  });

  it("calls a real price change legitimate and still publishes it", () => {
    const changed = CATALOG.map((record) =>
      record.sku === "MTR-100" ? { ...record, price: 52.25 } : record,
    );
    const decision = classify(changed, CATALOG);
    assert.equal(decision.classification, "legitimate_change");
    assert.equal(decision.recommendedAction, "publish");
    assert.ok(decision.evidence.some((line) => line.includes("49.95")));
  });

  it("never recommends healing a legitimate change", () => {
    const changed = CATALOG.map((record) => ({
      ...record,
      price: record.price * 2,
      availability: "out_of_stock",
    }));
    const decision = classify(changed, CATALOG);
    assert.notEqual(decision.recommendedAction, "heal");
    assert.notEqual(decision.classification, "structural_break");
  });

  it("treats the first ever run as healthy, since there is nothing to compare", () => {
    assert.equal(classify(CATALOG, null).classification, "healthy");
    assert.equal(classify(CATALOG, []).classification, "healthy");
  });

  it("refuses to publish when more than half the rows disappear", () => {
    // Every remaining row is valid, so the contract alone would accept this.
    // Silently dropping most of the data is the failure worth catching.
    const decision = classify(CATALOG.slice(0, 1), CATALOG);
    assert.equal(decision.classification, "ambiguous");
    assert.equal(decision.recommendedAction, "manual_review");
    assert.ok(decision.evidence.some((line) => /more than half/i.test(line)));
  });

  it("accepts a modest row-count drop as a legitimate change", () => {
    const decision = classify(CATALOG.slice(0, 2), CATALOG);
    assert.equal(decision.classification, "legitimate_change");
    assert.equal(decision.recommendedAction, "publish");
  });

  it("still prioritizes a structural break over any comparison", () => {
    const broken = [{ name: "", sku: "", price: -1, availability: "nope" }];
    const decision = classify(broken, CATALOG);
    assert.equal(decision.classification, "structural_break");
  });
});

describe("duplicate row detection", () => {
  it("rejects a run that returns the same row repeatedly", () => {
    // Every row is individually valid, and the row count matches the baseline,
    // so nothing else in the pipeline would catch this.
    const duplicated = [CATALOG[0], CATALOG[0], CATALOG[0]];
    const evaluation = evaluateContract(duplicated, CONTRACT);

    assert.equal(evaluation.valid, false);
    assert.ok(
      evaluation.violations.some((violation) => violation.code === "identity_duplicated"),
    );
    assert.equal(evaluation.acceptedRecords.length, 1, "only the first row may be accepted");
  });

  it("classifies duplicated extraction as a structural break, not a data change", () => {
    const duplicated = [CATALOG[0], CATALOG[0], CATALOG[0]];
    const decision = classify(duplicated, CATALOG);

    assert.equal(decision.classification, "structural_break");
    assert.equal(decision.recommendedAction, "heal");
  });

  it("treats duplicate identities case-insensitively", () => {
    const mixedCase = [
      CATALOG[0],
      { ...CATALOG[0], sku: (CATALOG[0]?.sku ?? "").toLowerCase() },
    ];
    assert.equal(evaluateContract(mixedCase, CONTRACT).valid, false);
  });

  it("still accepts genuinely distinct rows", () => {
    assert.equal(evaluateContract(CATALOG, CONTRACT).valid, true);
  });
});
