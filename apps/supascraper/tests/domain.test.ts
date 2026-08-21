import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  DEFAULT_CATALOG_CONTRACT,
  evaluateCatalogContract,
} from "../dist/domain/contracts/catalog-contract.js";
import type { NormalizedRunResult } from "../dist/domain/contracts/collector-run.js";
import { classifyRun } from "../dist/domain/detection/classify-run.js";
import {
  canTransition,
  transitionState,
  type OrchestrationState,
} from "../dist/domain/state-machine/state-machine.js";
import { loadConfig } from "../dist/config/config.js";
import { formatLogLine } from "../dist/infrastructure/logging/logger.js";
import { InMemoryRepository } from "../dist/infrastructure/persistence/in-memory-repository.js";
import {
  BrightDataIntegrationNotConfiguredError,
  UnconfiguredBrightDataAdapter,
} from "../dist/infrastructure/bright-data/bright-data-adapter.js";

const VALID_RECORD = {
  name: "Precision Stepper Motor",
  sku: "MTR-100",
  price: 49.95,
  availability: "in_stock",
};

const succeeded = (records: readonly unknown[]): NormalizedRunResult => ({
  collectorId: "c_test",
  targetUrl: "https://example.test/catalog",
  startedAt: "2026-08-21T00:00:00Z",
  finishedAt: "2026-08-21T00:00:05Z",
  status: "succeeded",
  records,
  snapshotId: null,
  safeError: null,
});

describe("evaluateCatalogContract", () => {
  it("accepts a valid dataset and counts it correctly", () => {
    const result = evaluateCatalogContract([VALID_RECORD]);
    assert.equal(result.valid, true);
    assert.equal(result.violations.length, 0);
    assert.equal(result.metrics.rowCount, 1);
    assert.equal(result.metrics.validRowCount, 1);
  });

  it("tolerates extra vendor fields that Bright Data adds", () => {
    const result = evaluateCatalogContract([
      { ...VALID_RECORD, product_page_url: "https://example.test/p/1", input: { url: "x" } },
    ]);
    assert.equal(result.valid, true);
  });

  it("rejects an empty dataset", () => {
    const result = evaluateCatalogContract([]);
    assert.equal(result.valid, false);
    assert.ok(result.violations.some((violation) => violation.code === "row_count_out_of_range"));
  });

  it("rejects a row count above the maximum", () => {
    const many = Array.from({ length: DEFAULT_CATALOG_CONTRACT.maximumRows + 1 }, () => VALID_RECORD);
    assert.equal(evaluateCatalogContract(many).valid, false);
  });

  it("reports the specific missing field", () => {
    const { price: _price, ...withoutPrice } = VALID_RECORD;
    const result = evaluateCatalogContract([withoutPrice]);
    assert.equal(result.valid, false);
    assert.ok(result.violations.some((violation) => violation.code === "price_invalid"));
    assert.equal(result.metrics.missingByField.price, 1);
    assert.equal(result.metrics.missingByField.name, 0);
  });

  it("distinguishes a null field from a missing field", () => {
    const result = evaluateCatalogContract([{ ...VALID_RECORD, price: null }]);
    assert.equal(result.metrics.nullByField.price, 1);
    assert.equal(result.metrics.missingByField.price, 0);
  });

  it("rejects wrong primitive types", () => {
    assert.equal(evaluateCatalogContract([{ ...VALID_RECORD, price: "49.95" }]).valid, false);
    assert.equal(evaluateCatalogContract([{ ...VALID_RECORD, name: 42 }]).valid, false);
    assert.equal(evaluateCatalogContract([{ ...VALID_RECORD, sku: null }]).valid, false);
  });

  it("rejects an empty or whitespace-only string", () => {
    assert.equal(evaluateCatalogContract([{ ...VALID_RECORD, name: "   " }]).valid, false);
    assert.equal(evaluateCatalogContract([{ ...VALID_RECORD, sku: "" }]).valid, false);
  });

  it("enforces the price domain rule", () => {
    assert.equal(evaluateCatalogContract([{ ...VALID_RECORD, price: -0.01 }]).valid, false);
    assert.equal(evaluateCatalogContract([{ ...VALID_RECORD, price: 0 }]).valid, true);
    assert.equal(evaluateCatalogContract([{ ...VALID_RECORD, price: Number.NaN }]).valid, false);
    assert.equal(
      evaluateCatalogContract([{ ...VALID_RECORD, price: Number.POSITIVE_INFINITY }]).valid,
      false,
    );
  });

  it("enforces the availability enumeration", () => {
    assert.equal(evaluateCatalogContract([{ ...VALID_RECORD, availability: "maybe" }]).valid, false);
    for (const availability of ["in_stock", "low_stock", "out_of_stock"]) {
      assert.equal(evaluateCatalogContract([{ ...VALID_RECORD, availability }]).valid, true);
    }
  });

  it("rejects non-object rows without throwing", () => {
    for (const row of [null, "string", 42, [], undefined]) {
      const result = evaluateCatalogContract([row]);
      assert.equal(result.valid, false);
      assert.ok(result.violations.some((violation) => violation.code === "record_type_invalid"));
    }
  });

  it("only accepts fully valid rows into acceptedRecords", () => {
    const result = evaluateCatalogContract([VALID_RECORD, { ...VALID_RECORD, price: -1 }]);
    assert.equal(result.valid, false);
    assert.equal(result.acceptedRecords.length, 1);
  });
});

describe("classifyRun", () => {
  it("classifies a valid run as healthy and publishable", () => {
    const decision = classifyRun(succeeded([VALID_RECORD]), evaluateCatalogContract([VALID_RECORD]));
    assert.equal(decision.classification, "healthy");
    assert.equal(decision.recommendedAction, "publish");
  });

  it("classifies a successful run with broken output as a structural break", () => {
    const records = [{ ...VALID_RECORD, price: undefined }];
    const decision = classifyRun(succeeded(records), evaluateCatalogContract(records));
    assert.equal(decision.classification, "structural_break");
    assert.equal(decision.recommendedAction, "heal");
    assert.ok(decision.evidence.length > 0);
  });

  it("never classifies a retryable transport failure as structural", () => {
    const run: NormalizedRunResult = {
      ...succeeded([]),
      status: "failed",
      records: [],
      safeError: { category: "network", message: "connection reset", retryable: true },
    };
    const decision = classifyRun(run, evaluateCatalogContract([]));
    assert.equal(decision.classification, "transient_error");
    assert.equal(decision.recommendedAction, "retry");
  });

  it("treats a timeout as transient, not structural", () => {
    const run: NormalizedRunResult = {
      ...succeeded([]),
      status: "timed_out",
      records: [],
      safeError: { category: "timeout", message: "deadline exceeded", retryable: true },
    };
    assert.equal(classifyRun(run, evaluateCatalogContract([])).classification, "transient_error");
  });

  it("routes a non-retryable failure to manual review rather than healing", () => {
    const run: NormalizedRunResult = {
      ...succeeded([]),
      status: "failed",
      records: [],
      safeError: { category: "auth", message: "forbidden", retryable: false },
    };
    const decision = classifyRun(run, evaluateCatalogContract([]));
    assert.equal(decision.classification, "ambiguous");
    assert.equal(decision.recommendedAction, "manual_review");
  });

  it("keeps confidence within range and is deterministic", () => {
    const records = [VALID_RECORD];
    const first = classifyRun(succeeded(records), evaluateCatalogContract(records));
    const second = classifyRun(succeeded(records), evaluateCatalogContract(records));
    assert.deepEqual(first, second);
    assert.ok(first.confidence >= 0 && first.confidence <= 1);
  });
});

describe("state machine", () => {
  it("requires the approval gate between healing and verifying", () => {
    assert.equal(canTransition("healing", "awaiting_approval"), true);
    assert.equal(canTransition("awaiting_approval", "verifying"), true);
    assert.equal(canTransition("healing", "verifying"), false);
    assert.equal(canTransition("healing", "recovered"), false);
    assert.equal(canTransition("awaiting_approval", "recovered"), false);
  });

  it("throws on an illegal transition instead of silently continuing", () => {
    assert.throws(() => transitionState("healing", "recovered"), /Illegal orchestration transition/);
  });

  it("allows manual review from every failure-capable state", () => {
    const states: OrchestrationState[] = [
      "running",
      "suspected",
      "retry_or_wait",
      "healing",
      "awaiting_approval",
      "verifying",
    ];
    for (const state of states) {
      assert.equal(canTransition(state, "manual_review"), true, state);
    }
  });
});

describe("loadConfig", () => {
  it("returns an unconfigured collector rather than throwing", () => {
    const config = loadConfig({});
    assert.equal(config.collector, null);
    assert.equal(config.port, 3000);
    assert.equal(config.geminiEnabled, false);
  });

  it("requires collector id and url together", () => {
    assert.throws(() => loadConfig({ SUPASCRAPER_COLLECTOR_ID: "c_x" }), /together/);
    assert.throws(
      () => loadConfig({ SUPASCRAPER_TARGET_URL: "https://example.test" }),
      /together/,
    );
  });

  it("rejects a collector id that is not a c_ identifier", () => {
    assert.throws(
      () =>
        loadConfig({
          SUPASCRAPER_COLLECTOR_ID: "x_bad",
          SUPASCRAPER_TARGET_URL: "https://example.test",
        }),
      /must start with c_/,
    );
  });

  it("rejects a non-HTTPS target unless it is localhost", () => {
    assert.throws(
      () =>
        loadConfig({
          SUPASCRAPER_COLLECTOR_ID: "c_x",
          SUPASCRAPER_TARGET_URL: "http://example.test",
        }),
      /HTTPS/,
    );
    const local = loadConfig({
      SUPASCRAPER_COLLECTOR_ID: "c_x",
      SUPASCRAPER_TARGET_URL: "http://localhost:3001/catalog",
    });
    assert.equal(local.collector?.collectorId, "c_x");
  });

  it("rejects invalid ports and boolean flags", () => {
    assert.throws(() => loadConfig({ SUPASCRAPER_PORT: "0" }), /positive integer/);
    assert.throws(() => loadConfig({ SUPASCRAPER_PORT: "70000" }), /65535/);
    assert.throws(() => loadConfig({ SUPASCRAPER_GEMINI_ENABLED: "yes" }), /true or false/);
  });
});

describe("InMemoryRepository", () => {
  it("does not let callers mutate stored data through returned references", async () => {
    const repository = new InMemoryRepository();
    const records = [{ ...VALID_RECORD }];
    await repository.saveLastKnownGood("c_x", records, "2026-08-21T00:00:00Z");

    records[0].price = 999;
    const snapshot = await repository.getLastKnownGood("c_x");
    assert.equal(snapshot?.records[0]?.price, 49.95);

    (snapshot?.records as { price: number }[])[0].price = 1;
    const again = await repository.getLastKnownGood("c_x");
    assert.equal(again?.records[0]?.price, 49.95);
  });

  it("grants a lock once and refuses a concurrent acquisition", async () => {
    const repository = new InMemoryRepository();
    const first = await repository.acquire("c_x");
    assert.ok(first);
    assert.equal(await repository.acquire("c_x"), null);
    await repository.release("c_x", first);
    assert.ok(await repository.acquire("c_x"));
  });

  it("refuses to release a lock owned by another operation", async () => {
    const repository = new InMemoryRepository();
    const token = await repository.acquire("c_x");
    assert.ok(token);
    await assert.rejects(repository.release("c_x", "not-the-token"), /another operation/);
  });

  it("filters events by collector", async () => {
    const repository = new InMemoryRepository();
    const base = {
      id: "1",
      targetUrl: "https://example.test",
      state: "healthy" as const,
      classification: "healthy" as const,
      confidence: 1,
      evidence: [],
      beforeMetrics: {
        rowCount: 1,
        validRowCount: 1,
        missingByField: { name: 0, sku: 0, price: 0, availability: 0 },
        nullByField: { name: 0, sku: 0, price: 0, availability: 0 },
      },
      afterMetrics: null,
      healPrompt: null,
      commandOutcome: null,
      verification: "not_started" as const,
      createdAt: "now",
      updatedAt: "now",
    };
    await repository.appendEvent({ ...base, collectorId: "c_a" });
    await repository.appendEvent({ ...base, id: "2", collectorId: "c_b" });
    assert.equal((await repository.listEvents("c_a")).length, 1);
  });
});

describe("UnconfiguredBrightDataAdapter", () => {
  it("fails closed on every operation so nothing can fake a repair", async () => {
    const adapter = new UnconfiguredBrightDataAdapter();
    const operations: [string, Promise<unknown>][] = [
      ["run", adapter.run({ collectorId: "c_x", targetUrl: "https://e.test", fieldDescription: "", timeoutMs: 1 })],
      ["heal", adapter.heal("c_x", "prompt")],
      ["approve", adapter.approve("c_x")],
      ["reject", adapter.reject("c_x")],
    ];
    for (const [name, promise] of operations) {
      await assert.rejects(promise, BrightDataIntegrationNotConfiguredError, name);
    }
  });
});

describe("formatLogLine", () => {
  it("survives a circular reference instead of throwing", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const line = formatLogLine("error", "boom", circular);
    assert.match(line, /not serializable/);
  });

  it("includes supplied details on the happy path", () => {
    assert.match(formatLogLine("info", "hello", { port: 3000 }), /"port":3000/);
  });
});

describe("committed Bright Data fixtures", () => {
  const load = (name: string): unknown[] =>
    JSON.parse(readFileSync(new URL(`../../../fixtures/samples/${name}`, import.meta.url), "utf8"));

  it("the recorded baseline satisfies the contract", () => {
    assert.equal(evaluateCatalogContract(load("collector-baseline.json")).valid, true);
  });

  it("the recorded structural break violates the contract", () => {
    const result = evaluateCatalogContract(load("collector-structural-break.json"));
    assert.equal(result.valid, false);
    assert.equal(result.metrics.validRowCount, 0);
  });

  it("the recorded recovery satisfies the contract and matches baseline", () => {
    const normalize = (records: unknown[]) =>
      records
        .map((record) => {
          const { name, sku, price, availability } = record as Record<string, unknown>;
          return { name, sku, price, availability };
        })
        .sort((a, b) => String(a.sku).localeCompare(String(b.sku)));

    const recovered = load("collector-recovered.json");
    assert.equal(evaluateCatalogContract(recovered).valid, true);
    assert.deepEqual(normalize(recovered), normalize(load("collector-baseline.json")));
  });

  it("a real broken run is classified as structural, not transient", () => {
    const broken = load("collector-structural-break.json");
    const decision = classifyRun(succeeded(broken), evaluateCatalogContract(broken));
    assert.equal(decision.classification, "structural_break");
  });
});
