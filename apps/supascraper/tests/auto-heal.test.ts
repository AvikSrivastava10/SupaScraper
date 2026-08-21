import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AUTO_HEAL_CONFIDENCE_THRESHOLD,
  processCollectorRun,
} from "../dist/application/process-run/process-run.js";
import {
  ContractPreviewReviewer,
  type HealAndVerifyDependencies,
  type HealEnvelope,
} from "../dist/application/heal-and-verify/heal-and-verify.js";
import { buildHealPrompt, MAX_HEAL_PROMPT_LENGTH } from "../dist/domain/repair/heal-prompt.js";
import { evaluateCatalogContract } from "../dist/domain/contracts/catalog-contract.js";
import type {
  CollectorConfig,
  NormalizedRunResult,
} from "../dist/domain/contracts/collector-run.js";
import type { RepairEvent } from "../dist/domain/repair/repair-event.js";

const VALID = [
  { name: "Precision Stepper Motor", sku: "MTR-100", price: 49.95, availability: "in_stock" },
];

const CONFIG: CollectorConfig = {
  collectorId: "c_test",
  targetUrl: "https://example.test/catalog",
  fieldDescription:
    "Extract every product with name, sku, price as a number, and availability.",
  timeoutMs: 1000,
};

const SELECTOR_FAILURE = {
  message: 'Crawler error: waiting for selector "span[data-field=title]" failed: timeout 30000ms exceeded',
  code: null,
  kind: "selector_timeout" as const,
};

const DEAD_PAGE = {
  message: "The navigation resulted in a dead page (404 status code)",
  code: "dead_page",
  kind: "unreachable_page" as const,
};

const run = (overrides: Partial<NormalizedRunResult> = {}): NormalizedRunResult => ({
  collectorId: "c_test",
  targetUrl: "https://example.test/catalog",
  startedAt: "2026-08-21T00:00:00Z",
  finishedAt: "2026-08-21T00:00:05Z",
  status: "succeeded",
  records: VALID,
  extractionErrors: [],
  snapshotId: null,
  safeError: null,
  ...overrides,
});

const envelope = (status: string, previewResult: unknown): HealEnvelope => ({
  status,
  completedSteps: ["planner", "code_fixer"],
  previewResult,
  diffSummary: "proposed template has 2 step(s)",
  safeMessage: "bdata scraper approve c_test",
});

interface Recorder {
  readonly events: RepairEvent[];
  readonly published: { records: readonly unknown[]; at: string }[];
  readonly calls: { heal: number; approve: number; reject: number; verify: number };
  readonly store: {
    saveLastKnownGood: (id: string, records: readonly never[], at: string) => Promise<void>;
    appendEvent: (event: RepairEvent) => Promise<void>;
  };
  readonly repair: HealAndVerifyDependencies;
}

function recorder(options: {
  healEnvelope?: HealEnvelope;
  verificationRecords?: readonly unknown[];
} = {}): Recorder {
  const events: RepairEvent[] = [];
  const published: { records: readonly unknown[]; at: string }[] = [];
  const calls = { heal: 0, approve: 0, reject: 0, verify: 0 };

  const store = {
    saveLastKnownGood: (_id: string, records: readonly never[], at: string) => {
      published.push({ records, at });
      return Promise.resolve();
    },
    appendEvent: (event: RepairEvent) => {
      events.push(event);
      return Promise.resolve();
    },
  };

  const repair: HealAndVerifyDependencies = {
    healer: {
      heal: () => {
        calls.heal += 1;
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
        calls.verify += 1;
        return Promise.resolve(run({ records: options.verificationRecords ?? VALID }));
      },
    },
    dataStore: store,
    lock: {
      acquire: () => Promise.resolve("token"),
      release: () => Promise.resolve(),
    },
  };

  return { events, published, calls, store, repair };
}

describe("buildHealPrompt", () => {
  it("reports the selector the scraper actually waited for", () => {
    const broken = run({ records: [], extractionErrors: [SELECTOR_FAILURE] });
    const prompt = buildHealPrompt({
      fieldDescription: CONFIG.fieldDescription,
      run: broken,
      evaluation: evaluateCatalogContract(broken.records),
    });
    assert.match(prompt, /span\[data-field=title\]/);
    assert.match(prompt, /restructured/);
    assert.ok(prompt.includes(CONFIG.fieldDescription));
  });

  it("never invents a selector when none was reported", () => {
    const broken = run({ records: [{ ...VALID[0], price: undefined }] });
    const prompt = buildHealPrompt({
      fieldDescription: CONFIG.fieldDescription,
      run: broken,
      evaluation: evaluateCatalogContract(broken.records),
    });
    assert.doesNotMatch(prompt, /\.[a-z-]+\s*\{|span\[|div\.|css/i);
    assert.match(prompt, /price/);
  });

  it("stays within the verified prompt limit even with long evidence", () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      name: "",
      sku: "",
      price: -1,
      availability: `bogus-${String(index)}`,
    }));
    const broken = run({ records: many });
    const prompt = buildHealPrompt({
      fieldDescription: "x".repeat(900),
      run: broken,
      evaluation: evaluateCatalogContract(broken.records),
    });
    assert.ok(prompt.length <= MAX_HEAL_PROMPT_LENGTH, `length was ${String(prompt.length)}`);
  });
});

describe("automatic repair gating", () => {
  it("does not heal when auto-heal is disabled", async () => {
    const harness = recorder();
    const broken = run({ records: [], extractionErrors: [SELECTOR_FAILURE] });
    const result = await processCollectorRun(broken, harness.store, harness.store, {
      autoHealEnabled: false,
      config: CONFIG,
      repair: harness.repair,
    });

    assert.equal(result.repair, null);
    assert.equal(harness.calls.heal, 0);
    assert.equal(result.state, "suspected");
  });

  it("does not heal without repair dependencies even if enabled", async () => {
    const harness = recorder();
    const broken = run({ records: [], extractionErrors: [SELECTOR_FAILURE] });
    const result = await processCollectorRun(broken, harness.store, harness.store, {
      autoHealEnabled: true,
      config: CONFIG,
    });
    assert.equal(result.repair, null);
    assert.equal(harness.calls.heal, 0);
  });

  it("never heals an unreachable page, no matter how many rows failed", async () => {
    const harness = recorder();
    const broken = run({
      records: [],
      extractionErrors: [DEAD_PAGE, DEAD_PAGE, DEAD_PAGE],
    });
    const result = await processCollectorRun(broken, harness.store, harness.store, {
      autoHealEnabled: true,
      config: CONFIG,
      repair: harness.repair,
    });

    assert.equal(result.decision.classification, "ambiguous");
    assert.equal(harness.calls.heal, 0);
    assert.equal(result.state, "manual_review");
  });

  it("never heals a transport failure", async () => {
    const harness = recorder();
    const failed = run({
      status: "timed_out",
      records: [],
      safeError: { category: "timeout", message: "deadline exceeded", retryable: true },
    });
    const result = await processCollectorRun(failed, harness.store, harness.store, {
      autoHealEnabled: true,
      config: CONFIG,
      repair: harness.repair,
    });

    assert.equal(result.decision.classification, "transient_error");
    assert.equal(harness.calls.heal, 0);
    assert.equal(result.state, "retry_or_wait");
  });

  it("never heals an empty but clean run", async () => {
    const harness = recorder();
    const empty = run({ records: [] });
    const result = await processCollectorRun(empty, harness.store, harness.store, {
      autoHealEnabled: true,
      config: CONFIG,
      repair: harness.repair,
    });

    assert.equal(result.decision.classification, "ambiguous");
    assert.equal(harness.calls.heal, 0);
  });

  it("does not heal a healthy run", async () => {
    const harness = recorder();
    const result = await processCollectorRun(run(), harness.store, harness.store, {
      autoHealEnabled: true,
      config: CONFIG,
      repair: harness.repair,
    });

    assert.equal(result.published, true);
    assert.equal(harness.calls.heal, 0);
    assert.equal(result.state, "healthy");
  });

  it("requires confidence at or above the documented threshold", () => {
    // Guards against silently lowering the bar for automatic mutation.
    assert.ok(AUTO_HEAL_CONFIDENCE_THRESHOLD >= 0.85);
  });
});

describe("automatic repair happy path", () => {
  it("heals, reviews, approves, verifies, and publishes", async () => {
    const harness = recorder();
    const broken = run({ records: [], extractionErrors: [SELECTOR_FAILURE] });
    const result = await processCollectorRun(broken, harness.store, harness.store, {
      autoHealEnabled: true,
      config: CONFIG,
      repair: harness.repair,
    });

    assert.equal(result.repair?.status, "recovered");
    assert.equal(harness.calls.heal, 1);
    assert.equal(harness.calls.approve, 1);
    assert.equal(harness.calls.reject, 0);
    assert.equal(harness.calls.verify, 1);
    assert.equal(result.published, true);
    assert.equal(result.state, "recovered");

    const event = harness.events.at(-1);
    assert.ok(event);
    assert.equal(event.verification, "passed");
    assert.ok(event.healPrompt);
    assert.ok(event.afterMetrics);
    assert.equal(event.commandOutcome, "awaiting_approval");
  });

  it("records the repair reason as evidence for the timeline", async () => {
    const harness = recorder();
    const broken = run({ records: [], extractionErrors: [SELECTOR_FAILURE] });
    await processCollectorRun(broken, harness.store, harness.store, {
      autoHealEnabled: true,
      config: CONFIG,
      repair: harness.repair,
    });

    const event = harness.events.at(-1);
    assert.ok(event?.evidence.some((line) => /recovered the original data contract/i.test(line)));
  });
});

describe("automatic repair failure paths", () => {
  it("withholds data and needs review when the rerun is still invalid", async () => {
    const harness = recorder({ verificationRecords: [{ name: "", sku: "", price: -1 }] });
    const broken = run({ records: [], extractionErrors: [SELECTOR_FAILURE] });
    const result = await processCollectorRun(broken, harness.store, harness.store, {
      autoHealEnabled: true,
      config: CONFIG,
      repair: harness.repair,
    });

    assert.equal(result.repair?.status, "manual_review");
    assert.equal(result.published, false);
    assert.equal(harness.published.length, 0, "nothing may be published");
    assert.equal(harness.events.at(-1)?.verification, "failed");
    assert.equal(result.state, "manual_review");
  });

  it("rejects an implausible preview instead of approving it", async () => {
    const harness = recorder({
      healEnvelope: envelope("awaiting_approval", [{ name: "x", sku: "y" }]),
    });
    const broken = run({ records: [], extractionErrors: [SELECTOR_FAILURE] });
    const result = await processCollectorRun(broken, harness.store, harness.store, {
      autoHealEnabled: true,
      config: CONFIG,
      repair: harness.repair,
    });

    assert.equal(harness.calls.reject, 1);
    assert.equal(harness.calls.approve, 0);
    assert.equal(harness.calls.verify, 0);
    assert.equal(result.published, false);
    assert.equal(result.state, "manual_review");
  });

  it("needs review when the heal never reaches the approval gate", async () => {
    const harness = recorder({ healEnvelope: envelope("failed", null) });
    const broken = run({ records: [], extractionErrors: [SELECTOR_FAILURE] });
    const result = await processCollectorRun(broken, harness.store, harness.store, {
      autoHealEnabled: true,
      config: CONFIG,
      repair: harness.repair,
    });

    assert.equal(harness.calls.approve, 0);
    assert.equal(harness.calls.verify, 0);
    assert.equal(result.state, "manual_review");
  });

  it("keeps a concurrent repair from starting twice", async () => {
    const harness = recorder();
    let held = false;
    const serialised: HealAndVerifyDependencies = {
      ...harness.repair,
      lock: {
        acquire: () => {
          if (held) return Promise.resolve(null);
          held = true;
          return Promise.resolve("token");
        },
        release: () => Promise.resolve(),
      },
    };

    const broken = run({ records: [], extractionErrors: [SELECTOR_FAILURE] });
    const first = await processCollectorRun(broken, harness.store, harness.store, {
      autoHealEnabled: true,
      config: CONFIG,
      repair: serialised,
    });
    const second = await processCollectorRun(broken, harness.store, harness.store, {
      autoHealEnabled: true,
      config: CONFIG,
      repair: serialised,
    });

    assert.equal(first.repair?.status, "recovered");
    assert.equal(second.repair?.status, "already_in_progress");
    assert.equal(harness.calls.heal, 1, "the second attempt must not heal");
  });
});
