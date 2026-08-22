import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  BOOTSTRAP_CONTRACT,
  evaluateContract,
  isProfiled,
  profileContract,
  tableColumns,
} from "../dist/domain/contracts/data-contract.js";
import type { NormalizedRunResult } from "../dist/domain/contracts/collector-run.js";
import { classifyRun } from "../dist/domain/detection/classify-run.js";
import {
  canTransition,
  transitionState,
  type OrchestrationState,
} from "../dist/domain/state-machine/state-machine.js";
import { isLoopbackHost, loadConfig } from "../dist/config/config.js";
import { parseRunOutput } from "../dist/infrastructure/bright-data/parse-run-output.js";
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

const SECOND_RECORD = {
  name: "Linear Rail 300mm",
  sku: "RAIL-300",
  price: 18.4,
  availability: "low_stock",
};

/**
 * The contract a real catalog run would have produced.
 *
 * Building it with the profiler rather than by hand is deliberate: every
 * assertion below then exercises the same path a brand new website takes.
 */
const CATALOG = profileContract([VALID_RECORD, SECOND_RECORD]);

const evaluate = (records: readonly unknown[]) => evaluateContract(records, CATALOG);

const codes = (records: readonly unknown[]): string[] =>
  evaluate(records).violations.map((violation) => violation.code);

const succeeded = (
  records: readonly unknown[],
  extractionErrors: NormalizedRunResult["extractionErrors"] = [],
): NormalizedRunResult => ({
  collectorId: "c_test",
  targetUrl: "https://example.test/catalog",
  startedAt: "2026-08-21T00:00:00Z",
  finishedAt: "2026-08-21T00:00:05Z",
  status: "succeeded",
  records,
  extractionErrors,
  snapshotId: null,
  safeError: null,
});

describe("profileContract", () => {
  it("learns the fields, types, and identity from a good run", () => {
    assert.deepEqual([...CATALOG.requiredFields].sort(), [
      "availability",
      "name",
      "price",
      "sku",
    ]);
    assert.equal(CATALOG.fieldTypes["price"], "number");
    assert.equal(CATALOG.fieldTypes["name"], "string");
    assert.equal(CATALOG.identityField, "sku");
    assert.equal(isProfiled(CATALOG), true);
  });

  it("works on a shape it has never seen before", () => {
    const contract = profileContract([
      { title: "Dune", author: "Herbert", isbn: "9780441013593", pages: 412 },
      { title: "Neuromancer", author: "Gibson", isbn: "9780441569595", pages: 271 },
    ]);
    assert.deepEqual([...contract.requiredFields].sort(), [
      "author",
      "isbn",
      "pages",
      "title",
    ]);
    assert.equal(contract.fieldTypes["pages"], "number");
    assert.equal(contract.identityField, "isbn");
  });

  it("treats a field missing from some rows as optional, not required", () => {
    const contract = profileContract([
      { id: "1", name: "a", discount: "10%" },
      { id: "2", name: "b" },
    ]);
    assert.deepEqual([...contract.requiredFields].sort(), ["id", "name"]);
    assert.ok(!contract.requiredFields.includes("discount"));
    // The optional field is still typed, so a later type change is detectable.
    assert.equal(contract.fieldTypes["discount"], "string");
  });

  it("treats an empty value as absent when deciding what is required", () => {
    const contract = profileContract([
      { id: "1", note: "hello" },
      { id: "2", note: "   " },
    ]);
    assert.deepEqual(contract.requiredFields, ["id"]);
  });

  it("treats an always-empty list or object as absent, not as populated", () => {
    // Observed live: a generated scraper returned `quotes: []` on every row. If
    // that counts as populated, the contract claims a field is present and
    // non-empty when it is empty every time, and the emptiness can never be
    // detected again.
    const contract = profileContract([
      { url: "https://a.test/1", quotes: [], meta: {} },
      { url: "https://a.test/2", quotes: [], meta: {} },
    ]);
    assert.deepEqual(contract.requiredFields, ["url"]);
    assert.ok(!contract.requiredFields.includes("quotes"));
    assert.ok(!contract.requiredFields.includes("meta"));
  });

  it("requires a list that actually carries values", () => {
    const contract = profileContract([
      { url: "https://a.test/1", tags: ["x"] },
      { url: "https://a.test/2", tags: ["y", "z"] },
    ]);
    assert.ok(contract.requiredFields.includes("tags"));
    assert.equal(contract.fieldTypes["tags"], "array");
  });

  it("types nested structures so a list cannot quietly become a string", () => {
    const contract = profileContract([{ tags: ["x"], author: { name: "A" } }]);
    assert.equal(contract.fieldTypes["tags"], "array");
    assert.equal(contract.fieldTypes["author"], "object");

    const broken = evaluateContract([{ tags: "x, y", author: { name: "A" } }], contract);
    assert.equal(broken.valid, false);
    assert.ok(broken.violations.some((violation) => violation.code === "tags_type_invalid"));
  });

  it("never picks a list or an object as the identity field", () => {
    const contract = profileContract([
      { tags: ["a"], label: "first" },
      { tags: ["b"], label: "second" },
    ]);
    assert.equal(contract.identityField, "label");
  });

  it("never profiles the vendor fields Bright Data adds", () => {
    const contract = profileContract([
      { ...VALID_RECORD, input: { url: "x" }, timestamp: "2026-01-01", warning: null },
    ]);
    assert.ok(!contract.requiredFields.includes("input"));
    assert.ok(!contract.requiredFields.includes("timestamp"));
    assert.ok(!contract.requiredFields.includes("warning"));
  });

  it("prefers a conventional identifier over an incidental unique field", () => {
    const contract = profileContract([
      { name: "only-unique-by-accident", sku: "A1" },
      { name: "another", sku: "A2" },
    ]);
    assert.equal(contract.identityField, "sku");
  });

  it("falls back to any unique field when no conventional name exists", () => {
    const contract = profileContract([
      { title: "First", body: "same" },
      { title: "Second", body: "same" },
    ]);
    assert.equal(contract.identityField, "title");
  });

  it("reports no identity when nothing is unique", () => {
    const contract = profileContract([
      { tag: "a", group: "x" },
      { tag: "a", group: "x" },
    ]);
    assert.equal(contract.identityField, null);
  });

  it("allows room for the data to grow", () => {
    const contract = profileContract([VALID_RECORD, SECOND_RECORD]);
    assert.ok(contract.maximumRows >= 50);
    assert.equal(contract.minimumRows, 1);
  });
});

describe("BOOTSTRAP_CONTRACT", () => {
  it("is not mistaken for a learned contract", () => {
    assert.equal(isProfiled(BOOTSTRAP_CONTRACT), false);
  });

  it("accepts any shape of real data, so a new site can be profiled", () => {
    const result = evaluateContract(
      [{ anything: "at all" }, { totally: "different", shape: 2 }],
      BOOTSTRAP_CONTRACT,
    );
    assert.equal(result.valid, true);
    assert.equal(result.acceptedRecords.length, 2);
  });

  it("still rejects a run that returned nothing", () => {
    const result = evaluateContract([], BOOTSTRAP_CONTRACT);
    assert.equal(result.valid, false);
    assert.ok(result.violations.some((violation) => violation.code === "row_count_too_low"));
  });

  it("still rejects rows that carry no data", () => {
    const result = evaluateContract(
      [{ input: { url: "x" }, timestamp: "2026-01-01" }],
      BOOTSTRAP_CONTRACT,
    );
    assert.equal(result.valid, false);
    assert.ok(result.violations.some((violation) => violation.code === "record_has_no_data"));
    assert.equal(result.acceptedRecords.length, 0);
  });

  it("rejects a row whose values are all empty", () => {
    const result = evaluateContract([{ name: "", sku: null }], BOOTSTRAP_CONTRACT);
    assert.equal(result.valid, false);
    assert.ok(result.violations.some((violation) => violation.code === "record_has_no_data"));
  });

  it("rejects a row carrying only empty containers", () => {
    const result = evaluateContract([{ quotes: [], meta: {} }], BOOTSTRAP_CONTRACT);
    assert.equal(result.valid, false);
    assert.ok(result.violations.some((violation) => violation.code === "record_has_no_data"));
  });
});

describe("evaluateContract", () => {
  it("accepts a valid dataset and counts it correctly", () => {
    const result = evaluate([VALID_RECORD]);
    assert.equal(result.valid, true);
    assert.equal(result.violations.length, 0);
    assert.equal(result.metrics.rowCount, 1);
    assert.equal(result.metrics.validRowCount, 1);
  });

  it("tolerates extra vendor fields that Bright Data adds", () => {
    const result = evaluate([
      { ...VALID_RECORD, product_page_url: "https://example.test/p/1", input: { url: "x" } },
    ]);
    assert.equal(result.valid, true);
  });

  it("rejects an empty dataset", () => {
    assert.ok(codes([]).includes("row_count_too_low"));
  });

  it("rejects a row count above the maximum", () => {
    const many = Array.from({ length: CATALOG.maximumRows + 1 }, (_unused, index) => ({
      ...VALID_RECORD,
      sku: `MTR-${String(index)}`,
    }));
    assert.ok(codes(many).includes("row_count_too_high"));
  });

  it("reports the specific missing field", () => {
    const { price: _price, ...withoutPrice } = VALID_RECORD;
    const result = evaluate([withoutPrice]);
    assert.equal(result.valid, false);
    assert.ok(result.violations.some((violation) => violation.code === "price_missing"));
    assert.equal(result.metrics.missingByField["price"], 1);
    assert.equal(result.metrics.missingByField["name"], 0);
  });

  it("distinguishes an empty field from a missing field", () => {
    const result = evaluate([{ ...VALID_RECORD, price: null }]);
    assert.equal(result.metrics.nullByField["price"], 1);
    assert.equal(result.metrics.missingByField["price"], 0);
  });

  it("rejects a value whose type no longer matches what was learned", () => {
    assert.ok(codes([{ ...VALID_RECORD, price: "49.95" }]).includes("price_type_invalid"));
    assert.ok(codes([{ ...VALID_RECORD, name: 42 }]).includes("name_type_invalid"));
  });

  it("rejects an empty, whitespace-only, or null value", () => {
    assert.ok(codes([{ ...VALID_RECORD, name: "   " }]).includes("name_empty"));
    assert.ok(codes([{ ...VALID_RECORD, sku: "" }]).includes("sku_empty"));
    assert.ok(codes([{ ...VALID_RECORD, sku: null }]).includes("sku_empty"));
  });

  it("refuses a number that is not finite", () => {
    assert.ok(codes([{ ...VALID_RECORD, price: Number.NaN }]).includes("price_type_invalid"));
    assert.ok(
      codes([{ ...VALID_RECORD, price: Number.POSITIVE_INFINITY }]).includes(
        "price_type_invalid",
      ),
    );
  });

  it("does not invent value rules it could not have learned", () => {
    // A negative number is not a contract violation. Nothing in a scraped page
    // tells us a field is a price, so inventing a domain rule would reject
    // legitimate data on other sites.
    assert.equal(evaluate([{ ...VALID_RECORD, price: -0.01 }]).valid, true);
  });

  it("rejects a duplicated identity, because it means one row was matched twice", () => {
    const result = evaluate([VALID_RECORD, { ...VALID_RECORD, name: "Different name" }]);
    assert.equal(result.valid, false);
    assert.ok(result.violations.some((violation) => violation.code === "identity_duplicated"));
    assert.equal(result.acceptedRecords.length, 1);
  });

  it("rejects non-object rows without throwing", () => {
    for (const row of [null, "string", 42, [], undefined]) {
      const result = evaluate([row]);
      assert.equal(result.valid, false);
      assert.ok(result.violations.some((violation) => violation.code === "record_type_invalid"));
    }
  });

  it("only accepts fully valid rows into acceptedRecords", () => {
    const { price: _price, ...broken } = SECOND_RECORD;
    const result = evaluate([VALID_RECORD, broken]);
    assert.equal(result.valid, false);
    assert.equal(result.acceptedRecords.length, 1);
  });
});

describe("tableColumns", () => {
  it("puts the identity first when a contract has been learned", () => {
    assert.equal(tableColumns(CATALOG, [VALID_RECORD])[0], "sku");
  });

  it("falls back to the data itself before any contract exists", () => {
    const columns = tableColumns(null, [{ alpha: 1, beta: 2, input: {} }]);
    assert.deepEqual(columns, ["alpha", "beta"]);
  });

  it("returns nothing to render when there is neither contract nor data", () => {
    assert.deepEqual(tableColumns(null, []), []);
  });
});

describe("classifyRun", () => {
  it("classifies a valid run as healthy and publishable", () => {
    const decision = classifyRun(succeeded([VALID_RECORD]), evaluate([VALID_RECORD]));
    assert.equal(decision.classification, "healthy");
    assert.equal(decision.recommendedAction, "publish");
  });

  it("classifies a successful run with broken output as a structural break", () => {
    const records = [{ ...VALID_RECORD, price: undefined }];
    const decision = classifyRun(succeeded(records), evaluate(records));
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
    const decision = classifyRun(run, evaluate([]));
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
    assert.equal(classifyRun(run, evaluate([])).classification, "transient_error");
  });

  it("routes a non-retryable failure to manual review rather than healing", () => {
    const run: NormalizedRunResult = {
      ...succeeded([]),
      status: "failed",
      records: [],
      safeError: { category: "auth", message: "forbidden", retryable: false },
    };
    const decision = classifyRun(run, evaluate([]));
    assert.equal(decision.classification, "ambiguous");
    assert.equal(decision.recommendedAction, "manual_review");
  });

  it("keeps confidence within range and is deterministic", () => {
    const records = [VALID_RECORD];
    const first = classifyRun(succeeded(records), evaluate(records));
    const second = classifyRun(succeeded(records), evaluate(records));
    assert.deepEqual(first, second);
    assert.ok(first.confidence >= 0 && first.confidence <= 1);
  });

  it("holds an unprofiled site to the bootstrap contract only", () => {
    const rows = [{ headline: "Something happened", url: "https://news.test/1" }];
    const decision = classifyRun(
      succeeded(rows),
      evaluateContract(rows, BOOTSTRAP_CONTRACT),
      null,
      BOOTSTRAP_CONTRACT,
    );
    assert.equal(decision.classification, "healthy");
    assert.equal(decision.recommendedAction, "publish");
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

  it("supplies a place to persist sites added at runtime", () => {
    const config = loadConfig({});
    assert.match(config.addedTargetsPath, /targets\.json$/);
    assert.ok(config.defaultRunTimeoutMs > 0);
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

  it("treats loopback hosts as unexposed", () => {
    assert.equal(isLoopbackHost("127.0.0.1"), true);
    assert.equal(isLoopbackHost("0.0.0.0"), false);
  });
});

describe("InMemoryRepository", () => {
  it("does not let callers mutate stored data through returned references", async () => {
    const repository = new InMemoryRepository();
    const records = [{ ...VALID_RECORD }];
    await repository.saveLastKnownGood("c_x", records, "2026-08-21T00:00:00Z");

    records[0].price = 999;
    const snapshot = await repository.getLastKnownGood("c_x");
    assert.equal(snapshot?.records[0]?.["price"], 49.95);

    (snapshot?.records as { price: number }[])[0].price = 1;
    const again = await repository.getLastKnownGood("c_x");
    assert.equal(again?.records[0]?.["price"], 49.95);
  });

  it("remembers a learned contract per collector", async () => {
    const repository = new InMemoryRepository();
    assert.equal(await repository.getContract("c_x"), null);
    await repository.saveContract("c_x", CATALOG);
    assert.equal((await repository.getContract("c_x"))?.identityField, "sku");
    assert.equal(await repository.getContract("c_other"), null);
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
        missingByField: {},
        nullByField: {},
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
      ["create", adapter.create({ url: "https://e.test", description: "d", name: "n" })],
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

  /** Learned from the recorded good run, exactly as the running system would. */
  const fixtureContract = profileContract(
    parseRunOutput(
      readFileSync(
        new URL("../../../fixtures/samples/collector-baseline.json", import.meta.url),
        "utf8",
      ),
    ).records as Record<string, unknown>[],
  );

  it("learns a usable contract from the recorded good run", () => {
    assert.ok(fixtureContract.requiredFields.includes("sku"));
    assert.equal(fixtureContract.identityField, "sku");
  });

  it("the recorded baseline satisfies the contract", () => {
    assert.equal(evaluateContract(load("collector-baseline.json"), fixtureContract).valid, true);
  });

  it("the recorded structural break violates the contract", () => {
    const result = evaluateContract(load("collector-structural-break.json"), fixtureContract);
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
    assert.equal(evaluateContract(recovered, fixtureContract).valid, true);
    assert.deepEqual(normalize(recovered), normalize(load("collector-baseline.json")));
  });

  it("a real broken run parses into extraction errors and classifies as structural", () => {
    const parsed = parseRunOutput(
      readFileSync(
        new URL("../../../fixtures/samples/collector-structural-break.json", import.meta.url),
        "utf8",
      ),
    );
    assert.equal(parsed.records.length, 0, "error rows must not be treated as data");
    assert.equal(parsed.extractionErrors.length, 3);
    assert.ok(parsed.extractionErrors.every((error) => error.kind === "selector_timeout"));

    const decision = classifyRun(
      succeeded(parsed.records, parsed.extractionErrors),
      evaluateContract(parsed.records, fixtureContract),
      null,
      fixtureContract,
    );
    assert.equal(decision.classification, "structural_break");
    assert.equal(decision.recommendedAction, "heal");
  });

  it("a real successful run parses cleanly with no extraction errors", () => {
    const parsed = parseRunOutput(
      readFileSync(
        new URL("../../../fixtures/samples/collector-baseline.json", import.meta.url),
        "utf8",
      ),
    );
    assert.equal(parsed.extractionErrors.length, 0);
    assert.equal(parsed.records.length, 3);
    const decision = classifyRun(
      succeeded(parsed.records),
      evaluateContract(parsed.records, fixtureContract),
      null,
      fixtureContract,
    );
    assert.equal(decision.classification, "healthy");
    assert.equal(decision.recommendedAction, "publish");
  });
});
