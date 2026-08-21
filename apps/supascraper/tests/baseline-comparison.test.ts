import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compareToBaseline,
  describeDiff,
} from "../dist/domain/detection/compare-baseline.js";
import { classifyRun } from "../dist/domain/detection/classify-run.js";
import { evaluateCatalogContract } from "../dist/domain/contracts/catalog-contract.js";
import type { NormalizedRunResult } from "../dist/domain/contracts/collector-run.js";

const CATALOG = [
  { name: "Precision Stepper Motor", sku: "MTR-100", price: 49.95, availability: "in_stock" as const },
  { name: "Industrial Sensor Module", sku: "SNS-240", price: 84.5, availability: "low_stock" as const },
  { name: "Compact Control Relay", sku: "RLY-310", price: 29.75, availability: "out_of_stock" as const },
];

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
  classifyRun(run(records), evaluateCatalogContract(records), baseline as never);

describe("compareToBaseline", () => {
  it("finds no changes for identical data", () => {
    const diff = compareToBaseline(CATALOG, CATALOG.map((record) => ({ ...record })));
    assert.equal(diff.hasChanges, false);
    assert.equal(diff.changes.length, 0);
  });

  it("detects a price change with before and after", () => {
    const changed = CATALOG.map((record) =>
      record.sku === "MTR-100" ? { ...record, price: 52.25 } : record,
    );
    const diff = compareToBaseline(CATALOG, changed);
    assert.equal(diff.hasChanges, true);
    assert.equal(diff.changes.length, 1);
    assert.deepEqual(diff.changes[0], {
      sku: "MTR-100",
      field: "price",
      before: 49.95,
      after: 52.25,
    });
  });

  it("detects availability and name changes", () => {
    const changed = CATALOG.map((record) =>
      record.sku === "SNS-240"
        ? { ...record, availability: "in_stock" as const, name: "Renamed Module" }
        : record,
    );
    const diff = compareToBaseline(CATALOG, changed);
    const fields = diff.changes.map((change) => change.field).sort();
    assert.deepEqual(fields, ["availability", "name"]);
  });

  it("reports added and removed products", () => {
    const changed = [
      ...CATALOG.slice(1),
      { name: "New Widget", sku: "WDG-900", price: 12.5, availability: "in_stock" as const },
    ];
    const diff = compareToBaseline(CATALOG, changed);
    assert.deepEqual(diff.addedSkus, ["WDG-900"]);
    assert.deepEqual(diff.removedSkus, ["MTR-100"]);
    assert.equal(diff.hasChanges, true);
  });

  it("summarizes a large diff without flooding the evidence", () => {
    const changed = CATALOG.map((record) => ({ ...record, price: record.price + 1 }));
    const lines = describeDiff(compareToBaseline(CATALOG, changed), 2);
    assert.equal(lines.length, 3);
    assert.match(lines[2] ?? "", /1 more field change/);
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
      availability: "out_of_stock" as const,
    }));
    const decision = classify(changed, CATALOG);
    assert.notEqual(decision.recommendedAction, "heal");
    assert.notEqual(decision.classification, "structural_break");
  });

  it("treats the first ever run as healthy, since there is nothing to compare", () => {
    assert.equal(classify(CATALOG, null).classification, "healthy");
    assert.equal(classify(CATALOG, []).classification, "healthy");
  });

  it("refuses to publish when more than half the catalog disappears", () => {
    // Every remaining row is valid, so the contract alone would accept this.
    // Silently dropping most of the catalog is the failure worth catching.
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
