import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatScore,
  scoreHealth,
  UNKNOWN_HEALTH,
} from "../dist/domain/health/health-score.js";
import { profileContract } from "../dist/domain/contracts/data-contract.js";

const CONTRACT = profileContract([
  { name: "Motor", sku: "MTR-100", price: 49.95, availability: "in_stock" },
  { name: "Rail", sku: "RAIL-300", price: 18.4, availability: "low_stock" },
]);

const metrics = (overrides: Record<string, unknown> = {}) => ({
  rowCount: 2,
  validRowCount: 2,
  missingByField: { name: 0, sku: 0, price: 0, availability: 0 },
  nullByField: { name: 0, sku: 0, price: 0, availability: 0 },
  ...overrides,
});

const NOW = Date.parse("2026-08-22T12:00:00Z");
const ago = (minutes: number): string =>
  new Date(NOW - minutes * 60_000).toISOString();

describe("scoreHealth with no history", () => {
  it("scores nothing at all rather than defaulting to perfect", () => {
    // A dashboard reporting 100% for "never run" is lying, and it is exactly the
    // lie that would make this product untrustworthy.
    const health = scoreHealth({
      metrics: null,
      contract: null,
      collectedAt: null,
      scheduleMinutes: null,
      now: NOW,
    });
    assert.deepEqual(health, UNKNOWN_HEALTH);
  });

  it("does not invent an extraction score from an absent run", () => {
    const health = scoreHealth({
      metrics: null,
      contract: CONTRACT,
      collectedAt: ago(1),
      scheduleMinutes: 30,
      now: NOW,
    });
    assert.equal(health.extraction, null);
    assert.equal(health.schema, null);
    assert.equal(health.freshness, 1, "freshness can still be judged from the timestamp");
  });
});

describe("extraction score", () => {
  it("is the share of returned rows that were usable", () => {
    const health = scoreHealth({
      metrics: metrics({ rowCount: 4, validRowCount: 1 }),
      contract: CONTRACT,
      collectedAt: ago(1),
      scheduleMinutes: null,
      now: NOW,
    });
    assert.equal(health.extraction, 0.25);
  });

  it("is zero when a run returned nothing, not null", () => {
    // The collector did report; it reported no usable data. That is a result.
    const health = scoreHealth({
      metrics: metrics({ rowCount: 0, validRowCount: 0 }),
      contract: CONTRACT,
      collectedAt: ago(1),
      scheduleMinutes: null,
      now: NOW,
    });
    assert.equal(health.extraction, 0);
  });

  it("is full when every row held", () => {
    const health = scoreHealth({
      metrics: metrics(),
      contract: CONTRACT,
      collectedAt: ago(1),
      scheduleMinutes: null,
      now: NOW,
    });
    assert.equal(health.extraction, 1);
  });
});

describe("schema score", () => {
  it("counts per field, so one field vanishing everywhere is not averaged away", () => {
    const health = scoreHealth({
      metrics: metrics({
        rowCount: 2,
        validRowCount: 0,
        missingByField: { name: 0, sku: 0, price: 2, availability: 0 },
      }),
      contract: CONTRACT,
      collectedAt: ago(1),
      scheduleMinutes: null,
      now: NOW,
    });
    assert.equal(health.schema, 0.75, "three of four fields survived");
  });

  it("treats an empty field as broken, not merely as different from missing", () => {
    const health = scoreHealth({
      metrics: metrics({
        nullByField: { name: 0, sku: 0, price: 2, availability: 0 },
      }),
      contract: CONTRACT,
      collectedAt: ago(1),
      scheduleMinutes: null,
      now: NOW,
    });
    assert.equal(health.schema, 0.75);
  });

  it("cannot be measured without a contract", () => {
    const health = scoreHealth({
      metrics: metrics(),
      contract: null,
      collectedAt: ago(1),
      scheduleMinutes: null,
      now: NOW,
    });
    assert.equal(health.schema, null);
  });

  it("cannot be measured when the contract requires nothing", () => {
    const empty = profileContract([{ note: "" }]);
    const health = scoreHealth({
      metrics: metrics(),
      contract: empty,
      collectedAt: ago(1),
      scheduleMinutes: null,
      now: NOW,
    });
    assert.equal(health.schema, null);
  });
});

describe("freshness score", () => {
  it("has nothing to judge against when there is no schedule", () => {
    // Inventing a decay curve for on-demand collection would put a
    // precise-looking figure on a question nobody asked.
    const health = scoreHealth({
      metrics: metrics(),
      contract: CONTRACT,
      collectedAt: ago(5),
      scheduleMinutes: null,
      now: NOW,
    });
    assert.equal(health.freshness, null);
  });

  it("is full inside one interval", () => {
    for (const minutes of [0, 10, 30]) {
      const health = scoreHealth({
        metrics: metrics(),
        contract: CONTRACT,
        collectedAt: ago(minutes),
        scheduleMinutes: 30,
        now: NOW,
      });
      assert.equal(health.freshness, 1, `${String(minutes)}m`);
    }
  });

  it("declines once a run has been missed", () => {
    const health = scoreHealth({
      metrics: metrics(),
      contract: CONTRACT,
      collectedAt: ago(60),
      scheduleMinutes: 30,
      now: NOW,
    });
    assert.equal(health.freshness, 0.5);
  });

  it("reaches zero by the third missed interval", () => {
    for (const minutes of [90, 200, 5000]) {
      const health = scoreHealth({
        metrics: metrics(),
        contract: CONTRACT,
        collectedAt: ago(minutes),
        scheduleMinutes: 30,
        now: NOW,
      });
      assert.equal(health.freshness, 0, `${String(minutes)}m`);
    }
  });

  it("ignores an unparseable timestamp instead of scoring it", () => {
    const health = scoreHealth({
      metrics: metrics(),
      contract: CONTRACT,
      collectedAt: "not a date",
      scheduleMinutes: 30,
      now: NOW,
    });
    assert.equal(health.freshness, null);
  });
});

describe("overall score", () => {
  it("averages only the components that could be measured", () => {
    const health = scoreHealth({
      metrics: metrics({ rowCount: 2, validRowCount: 1 }),
      contract: CONTRACT,
      collectedAt: ago(1),
      scheduleMinutes: null,
      now: NOW,
    });
    // Extraction 0.5 and schema 1. Freshness is unmeasurable and must not be
    // counted as either a success or a failure.
    assert.equal(health.extraction, 0.5);
    assert.equal(health.schema, 1);
    assert.equal(health.freshness, null);
    assert.equal(health.overall, 0.75);
  });

  it("records when the figures were taken from", () => {
    const at = ago(3);
    const health = scoreHealth({
      metrics: metrics(),
      contract: CONTRACT,
      collectedAt: at,
      scheduleMinutes: null,
      now: NOW,
    });
    assert.equal(health.checkedAt, at);
  });

  it("stays within range for absurd inputs", () => {
    const health = scoreHealth({
      metrics: metrics({ rowCount: 2, validRowCount: 99 }),
      contract: CONTRACT,
      collectedAt: ago(-500),
      scheduleMinutes: 30,
      now: NOW,
    });
    for (const score of [health.extraction, health.freshness, health.overall]) {
      assert.ok(score !== null && score >= 0 && score <= 1, String(score));
    }
  });
});

describe("formatScore", () => {
  it("shows a dash for an unmeasurable component", () => {
    assert.equal(formatScore(null), "—");
  });

  it("rounds to whole percent, since row counts imply no more precision", () => {
    assert.equal(formatScore(1), "100%");
    assert.equal(formatScore(0), "0%");
    assert.equal(formatScore(0.9983), "100%");
    assert.equal(formatScore(0.755), "76%");
  });
});
