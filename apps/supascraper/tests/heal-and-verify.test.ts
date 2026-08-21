import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ContractPreviewReviewer,
  healAndVerify,
  type HealAndVerifyDependencies,
  type HealEnvelope,
} from "../dist/application/heal-and-verify/heal-and-verify.js";
import type {
  CollectorConfig,
  NormalizedRunResult,
} from "../dist/domain/contracts/collector-run.js";
import type { DetectionDecision } from "../dist/domain/detection/classify-run.js";

const VALID = [
  { name: "Precision Stepper Motor", sku: "MTR-100", price: 49.95, availability: "in_stock" },
];
const BROKEN = [{ name: "Precision Stepper Motor", sku: "MTR-100", availability: "in_stock" }];

const config: CollectorConfig = {
  collectorId: "c_test",
  targetUrl: "https://example.test/catalog",
  fieldDescription: "name, sku, price, availability",
  timeoutMs: 1000,
};

const structuralBreak: DetectionDecision = {
  classification: "structural_break",
  confidence: 0.9,
  evidence: ["price missing"],
  source: "deterministic",
  recommendedAction: "heal",
};

const run = (
  records: readonly unknown[],
  overrides: Partial<NormalizedRunResult> = {},
): NormalizedRunResult => ({
  collectorId: "c_test",
  targetUrl: "https://example.test/catalog",
  startedAt: "2026-08-21T00:00:00Z",
  finishedAt: "2026-08-21T00:00:05Z",
  status: "succeeded",
  records,
  extractionErrors: [],
  snapshotId: null,
  safeError: null,
  ...overrides,
});

const envelope = (status: string, previewResult: unknown): HealEnvelope => ({
  status,
  completedSteps: [],
  previewResult,
  diffSummary: "selector moved",
  safeMessage: "ok",
});

interface Calls {
  heal: number;
  approve: number;
  reject: number;
  run: number;
  publish: number;
  release: number;
}

function harness(options: {
  healEnvelope?: HealEnvelope;
  verificationRun?: NormalizedRunResult;
  lockAvailable?: boolean;
  healThrows?: boolean;
}): { calls: Calls; dependencies: HealAndVerifyDependencies } {
  const calls: Calls = { heal: 0, approve: 0, reject: 0, run: 0, publish: 0, release: 0 };
  const dependencies: HealAndVerifyDependencies = {
    healer: {
      heal: () => {
        calls.heal += 1;
        if (options.healThrows === true) {
          return Promise.reject(new Error("healer exploded"));
        }
        return Promise.resolve(options.healEnvelope ?? envelope("awaiting_approval", VALID));
      },
    },
    approver: {
      approve: () => {
        calls.approve += 1;
        return Promise.resolve();
      },
      reject: () => {
        calls.reject += 1;
        return Promise.resolve();
      },
    },
    reviewer: new ContractPreviewReviewer(),
    runner: {
      run: () => {
        calls.run += 1;
        return Promise.resolve(options.verificationRun ?? run(VALID));
      },
    },
    dataStore: {
      saveLastKnownGood: () => {
        calls.publish += 1;
        return Promise.resolve();
      },
      getLastKnownGood: () => Promise.resolve(null),
    },
    lock: {
      acquire: () => Promise.resolve(options.lockAvailable === false ? null : "token"),
      release: () => {
        calls.release += 1;
        return Promise.resolve();
      },
    },
  };
  return { calls, dependencies };
}

describe("healAndVerify entry policy", () => {
  it("refuses any classification other than a confirmed structural break", async () => {
    const { dependencies } = harness({});
    for (const classification of ["healthy", "legitimate_change", "transient_error", "ambiguous"] as const) {
      await assert.rejects(
        healAndVerify(
          { config, decision: { ...structuralBreak, classification }, healPrompt: "p" },
          dependencies,
        ),
        /Only a confirmed structural break/,
      );
    }
  });

  it("refuses a structural break whose recommended action is not heal", async () => {
    const { dependencies } = harness({});
    await assert.rejects(
      healAndVerify(
        { config, decision: { ...structuralBreak, recommendedAction: "manual_review" }, healPrompt: "p" },
        dependencies,
      ),
      /Only a confirmed structural break/,
    );
  });
});

describe("healAndVerify locking", () => {
  it("reports already in progress without healing when the lock is held", async () => {
    const { calls, dependencies } = harness({ lockAvailable: false });
    const outcome = await healAndVerify({ config, decision: structuralBreak, healPrompt: "p" }, dependencies);
    assert.equal(outcome.status, "already_in_progress");
    assert.equal(calls.heal, 0);
  });

  it("releases the lock even when the healer throws, without masking the error", async () => {
    const { calls, dependencies } = harness({ healThrows: true });
    await assert.rejects(
      healAndVerify({ config, decision: structuralBreak, healPrompt: "p" }, dependencies),
      /healer exploded/,
    );
    assert.equal(calls.release, 1);
  });

  it("does not let a failing release replace the original error", async () => {
    const { dependencies } = harness({ healThrows: true });
    const failing: HealAndVerifyDependencies = {
      ...dependencies,
      lock: {
        acquire: () => Promise.resolve("token"),
        release: () => Promise.reject(new Error("release blew up")),
      },
    };
    await assert.rejects(
      healAndVerify({ config, decision: structuralBreak, healPrompt: "p" }, failing),
      /healer exploded/,
    );
  });
});

describe("healAndVerify approval gate", () => {
  it("enters manual review when the heal never reaches the gate", async () => {
    const { calls, dependencies } = harness({ healEnvelope: envelope("failed", null) });
    const outcome = await healAndVerify({ config, decision: structuralBreak, healPrompt: "p" }, dependencies);
    assert.equal(outcome.status, "manual_review");
    assert.equal(calls.approve, 0);
    assert.equal(calls.run, 0);
    assert.equal(calls.publish, 0);
  });

  it("recognizes the real awaiting_approval status returned by the CLI", async () => {
    const { calls, dependencies } = harness({ healEnvelope: envelope("awaiting_approval", VALID) });
    const outcome = await healAndVerify({ config, decision: structuralBreak, healPrompt: "p" }, dependencies);
    assert.equal(outcome.status, "recovered");
    assert.equal(calls.approve, 1);
  });

  it("rejects an implausible preview and never approves it", async () => {
    const { calls, dependencies } = harness({ healEnvelope: envelope("awaiting_approval", BROKEN) });
    const outcome = await healAndVerify({ config, decision: structuralBreak, healPrompt: "p" }, dependencies);
    assert.equal(outcome.status, "manual_review");
    assert.equal(calls.reject, 1);
    assert.equal(calls.approve, 0);
    assert.equal(calls.run, 0);
    assert.equal(calls.publish, 0);
  });

  it("rejects a preview that parses but violates a domain rule", async () => {
    const negative = [{ ...VALID[0], price: -5 }];
    const { calls, dependencies } = harness({ healEnvelope: envelope("awaiting_approval", negative) });
    const outcome = await healAndVerify({ config, decision: structuralBreak, healPrompt: "p" }, dependencies);
    assert.equal(outcome.status, "manual_review");
    assert.equal(calls.reject, 1);
  });

  it("rejects a preview that is not a record array", async () => {
    for (const preview of [null, "rows", 42, { rows: VALID }]) {
      const { calls, dependencies } = harness({ healEnvelope: envelope("awaiting_approval", preview) });
      const outcome = await healAndVerify({ config, decision: structuralBreak, healPrompt: "p" }, dependencies);
      assert.equal(outcome.status, "manual_review");
      assert.equal(calls.approve, 0);
    }
  });
});

describe("healAndVerify verification", () => {
  it("does not report recovery when the rerun is still invalid", async () => {
    const { calls, dependencies } = harness({ verificationRun: run(BROKEN) });
    const outcome = await healAndVerify({ config, decision: structuralBreak, healPrompt: "p" }, dependencies);
    assert.equal(outcome.status, "manual_review");
    assert.equal(calls.publish, 0);
  });

  it("does not report recovery for a different collector id", async () => {
    const { calls, dependencies } = harness({
      verificationRun: run(VALID, { collectorId: "c_other" }),
    });
    const outcome = await healAndVerify({ config, decision: structuralBreak, healPrompt: "p" }, dependencies);
    assert.equal(outcome.status, "manual_review");
    assert.equal(calls.publish, 0);
    assert.match(outcome.reason, /same collector/);
  });

  it("does not report recovery for a different target url", async () => {
    const { calls, dependencies } = harness({
      verificationRun: run(VALID, { targetUrl: "https://elsewhere.test/catalog" }),
    });
    const outcome = await healAndVerify({ config, decision: structuralBreak, healPrompt: "p" }, dependencies);
    assert.equal(outcome.status, "manual_review");
    assert.equal(calls.publish, 0);
  });

  it("does not report recovery when the verification run fails or times out", async () => {
    for (const status of ["failed", "timed_out"] as const) {
      const { calls, dependencies } = harness({ verificationRun: run([], { status }) });
      const outcome = await healAndVerify({ config, decision: structuralBreak, healPrompt: "p" }, dependencies);
      assert.equal(outcome.status, "manual_review");
      assert.equal(calls.publish, 0);
    }
  });

  it("publishes and ends in recovered only on full success", async () => {
    const { calls, dependencies } = harness({});
    const outcome = await healAndVerify({ config, decision: structuralBreak, healPrompt: "p" }, dependencies);
    assert.equal(outcome.status, "recovered");
    assert.equal(outcome.finalState, "recovered");
    assert.equal(calls.publish, 1);
    assert.equal(calls.release, 1);
    assert.ok(outcome.verificationRun);
    assert.equal(outcome.review?.plausible, true);
  });
});

describe("ContractPreviewReviewer", () => {
  it("accepts the real envelope shape returned by CLI 0.3.5", () => {
    const real = envelope("awaiting_approval", [
      {
        name: "Precision Stepper Motor",
        sku: "MTR-100",
        price: 49.95,
        availability: "in_stock",
        product_page_url: "https://example.test/product/MTR-100",
      },
    ]);
    const review = new ContractPreviewReviewer().review(real);
    assert.equal(review.plausible, true);
    assert.ok(review.evidence.length > 0);
  });

  it("explains why a preview was rejected", () => {
    const review = new ContractPreviewReviewer().review(envelope("awaiting_approval", BROKEN));
    assert.equal(review.plausible, false);
    assert.ok(review.evidence.some((line) => line.includes("price")));
  });
});
