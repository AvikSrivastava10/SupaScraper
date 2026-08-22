import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  BrightDataApprovalNotSavedError,
  BrightDataCliAdapter,
  sanitizeCliText,
  type CliInvocation,
  type CliResult,
  type CliRunner,
} from "../dist/infrastructure/bright-data/cli-adapter.js";
import {
  classifyExtractionError,
  parseRunOutput,
  UnparseableRunOutputError,
} from "../dist/infrastructure/bright-data/parse-run-output.js";
import { JsonFileRepository } from "../dist/infrastructure/persistence/json-file-repository.js";
import { FileTargetRegistry } from "../dist/infrastructure/persistence/target-store.js";
import { createApplicationServer } from "../dist/presentation/api/server.js";
import {
  isShowingStaleData,
  renderDashboardPage,
} from "../dist/presentation/web/dashboard-page.js";
import { EXPORT_FORMATS } from "../dist/presentation/export/export-records.js";
import { profileContract } from "../dist/domain/contracts/data-contract.js";
import { loadConfig } from "../dist/config/config.js";
import { ConsoleLogger } from "../dist/infrastructure/logging/logger.js";
import type { CollectorConfig, NormalizedRunResult } from "../dist/domain/contracts/collector-run.js";

const SILENT = {
  info: () => undefined,
  error: () => undefined,
};

const CONFIG: CollectorConfig = {
  collectorId: "c_test",
  targetUrl: "https://example.test/catalog",
  fieldDescription: "name, sku, price, availability",
  timeoutMs: 5000,
};

const GOOD_ROW = {
  name: "Precision Stepper Motor",
  sku: "MTR-100",
  price: 49.95,
  availability: "in_stock",
  product_page_url: "https://example.test/product/MTR-100",
  input: { url: "https://example.test/catalog" },
};

class FakeCli implements CliRunner {
  readonly invocations: CliInvocation[] = [];
  #result: CliResult | Error;

  constructor(result: CliResult | Error) {
    this.#result = result;
  }

  set result(value: CliResult | Error) {
    this.#result = value;
  }

  invoke(invocation: CliInvocation): Promise<CliResult> {
    this.invocations.push(invocation);
    return this.#result instanceof Error
      ? Promise.reject(this.#result)
      : Promise.resolve(this.#result);
  }
}

const cliResult = (overrides: Partial<CliResult> = {}): CliResult => ({
  code: 0,
  stdout: "[]",
  stderr: "",
  timedOut: false,
  ...overrides,
});

describe("parseRunOutput", () => {
  it("separates data rows from per-row extraction errors", () => {
    const parsed = parseRunOutput(
      JSON.stringify([
        GOOD_ROW,
        { input: { url: "x" }, error: "Crawler error: waiting for selector \".x\" failed: timeout" },
      ]),
    );
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.extractionErrors.length, 1);
    assert.equal(parsed.extractionErrors[0]?.kind, "selector_timeout");
  });

  it("recognizes a dead page as unreachable rather than structural", () => {
    const parsed = parseRunOutput(
      JSON.stringify([
        {
          input: { url: "x" },
          error: "The navigation resulted in a dead page (404 status code)",
          error_code: "dead_page",
        },
      ]),
    );
    assert.equal(parsed.extractionErrors[0]?.kind, "unreachable_page");
  });

  it("accepts an empty array as a successful but empty run", () => {
    const parsed = parseRunOutput("[]");
    assert.equal(parsed.records.length, 0);
    assert.equal(parsed.extractionErrors.length, 0);
  });

  it("rejects output that is not a JSON array", () => {
    for (const raw of ["", "   ", "not json", "{}", '"text"', "42"]) {
      assert.throws(() => parseRunOutput(raw), UnparseableRunOutputError, raw);
    }
  });
});

describe("classifyExtractionError", () => {
  it("maps observed message shapes to the right kind", () => {
    assert.equal(classifyExtractionError("anything", "dead_page"), "unreachable_page");
    assert.equal(
      classifyExtractionError('Crawler error: waiting for selector ".p" failed: timeout 30000ms exceeded', null),
      "selector_timeout",
    );
    assert.equal(classifyExtractionError("something odd happened", null), "unknown");
  });

  it("never treats a page-load failure as a selector problem", () => {
    // Healing one of these would rewrite working extraction against a page that
    // never loaded, so none may be classified as a structural break.
    const pageFailures = [
      "Navigation timeout of 30000 ms exceeded",
      "net::ERR_CONNECTION_REFUSED",
      "net::ERR_NAME_NOT_RESOLVED at https://example.test",
      "The navigation resulted in a dead page (404 status code)",
      "DNS lookup failed",
    ];
    for (const message of pageFailures) {
      assert.notEqual(
        classifyExtractionError(message, null),
        "selector_timeout",
        message,
      );
    }
  });

  it("treats an unqualified timeout as unknown rather than structural", () => {
    assert.equal(classifyExtractionError("operation timed out", null), "unknown");
    assert.equal(classifyExtractionError("timeout 30000ms exceeded", null), "unknown");
  });

  it("recognizes xpath and element waits as selector failures", () => {
    assert.equal(
      classifyExtractionError("waiting for element .price failed", null),
      "selector_timeout",
    );
    assert.equal(classifyExtractionError("xpath //div[@id] not found", null), "selector_timeout");
  });
});

describe("sanitizeCliText", () => {
  it("strips ANSI escapes and collapses noise", () => {
    const noisy = "\u001B[32mok\u001B[0m\n\nsecond line\n";
    assert.equal(sanitizeCliText(noisy), "ok | second line");
  });

  it("truncates very long output", () => {
    assert.ok(sanitizeCliText("x".repeat(2000), 100).length <= 103);
  });
});

describe("BrightDataCliAdapter", () => {
  it("passes arguments as an array so nothing can be shell-interpolated", async () => {
    const cli = new FakeCli(cliResult({ stdout: JSON.stringify([GOOD_ROW]) }));
    const adapter = new BrightDataCliAdapter(cli, SILENT);
    const hostile: CollectorConfig = {
      ...CONFIG,
      targetUrl: "https://example.test/catalog?a=1&b=2",
    };
    await adapter.run(hostile);

    const invocation = cli.invocations[0];
    assert.ok(invocation);
    assert.ok(invocation.args.includes(hostile.targetUrl));
    assert.ok(invocation.args.includes("c_test"));
    // The URL must appear as its own argument, never spliced into a string.
    assert.ok(invocation.args.every((arg) => !arg.includes("&&")));
  });

  it("normalizes a successful run", async () => {
    const cli = new FakeCli(cliResult({ stdout: JSON.stringify([GOOD_ROW]) }));
    const result = await new BrightDataCliAdapter(cli, SILENT).run(CONFIG);
    assert.equal(result.status, "succeeded");
    assert.equal(result.records.length, 1);
    assert.equal(result.collectorId, "c_test");
  });

  it("treats a non-zero exit with usable JSON as success, because progress goes to stderr", async () => {
    const cli = new FakeCli(
      cliResult({ code: 1, stdout: JSON.stringify([GOOD_ROW]), stderr: "Triggering scrape..." }),
    );
    const result = await new BrightDataCliAdapter(cli, SILENT).run(CONFIG);
    assert.equal(result.status, "succeeded");
  });

  it("treats unparseable output as a failure, never an empty success", async () => {
    const cli = new FakeCli(cliResult({ stdout: "totally not json", stderr: "boom" }));
    const result = await new BrightDataCliAdapter(cli, SILENT).run(CONFIG);
    assert.equal(result.status, "failed");
    assert.equal(result.records.length, 0);
    assert.ok(result.safeError);
  });

  it("reports a timeout as timed_out and retryable", async () => {
    const cli = new FakeCli(cliResult({ timedOut: true, stdout: "" }));
    const result = await new BrightDataCliAdapter(cli, SILENT).run(CONFIG);
    assert.equal(result.status, "timed_out");
    assert.equal(result.safeError?.retryable, true);
  });

  it("reports a spawn failure without throwing", async () => {
    const cli = new FakeCli(new Error("ENOENT: node missing"));
    const result = await new BrightDataCliAdapter(cli, SILENT).run(CONFIG);
    assert.equal(result.status, "failed");
    assert.equal(result.safeError?.retryable, false);
  });

  it("maps the real heal envelope, leaving auto-approve off", async () => {
    const envelope = {
      collector_id: "c_test",
      status: "awaiting_approval",
      completed_steps: ["planner", "code_fixer"],
      preview_result: [GOOD_ROW],
      diff_summary: "proposed template has 2 step(s)",
      next_step: "bdata scraper approve c_test",
    };
    const cli = new FakeCli(cliResult({ stdout: JSON.stringify(envelope) }));
    const result = await new BrightDataCliAdapter(cli, SILENT).heal("c_test", "fix the price");

    assert.equal(result.status, "awaiting_approval");
    assert.ok(Array.isArray(result.previewResult));
    assert.equal(result.diffSummary, "proposed template has 2 step(s)");
    assert.ok(!cli.invocations[0]?.args.includes("--auto-approve"));
  });

  it("rejects an empty or over-long heal prompt", async () => {
    const adapter = new BrightDataCliAdapter(new FakeCli(cliResult()), SILENT);
    await assert.rejects(adapter.heal("c_test", "   "), /required/);
    await assert.rejects(adapter.heal("c_test", "x".repeat(1001)), /at most 1000/);
  });

  it("always approves with --auto-save", async () => {
    const cli = new FakeCli(
      cliResult({
        stdout: JSON.stringify({ completed_steps: ["user_approval", "save_new_template"] }),
      }),
    );
    await new BrightDataCliAdapter(cli, SILENT).approve("c_test");
    assert.ok(cli.invocations[0]?.args.includes("--auto-save"));
  });

  it("fails when approval did not persist the template", async () => {
    const cli = new FakeCli(
      cliResult({ stdout: JSON.stringify({ completed_steps: ["user_approval"] }) }),
    );
    await assert.rejects(
      new BrightDataCliAdapter(cli, SILENT).approve("c_test"),
      BrightDataApprovalNotSavedError,
    );
  });

  it("does not require a save step when rejecting", async () => {
    const cli = new FakeCli(cliResult({ stdout: JSON.stringify({ completed_steps: [] }) }));
    await new BrightDataCliAdapter(cli, SILENT).reject("c_test");
    assert.ok(cli.invocations[0]?.args.includes("--reject"));
  });
});

describe("JsonFileRepository", () => {
  let directory: string;

  before(() => {
    directory = mkdtempSync(join(tmpdir(), "supascraper-repo-"));
  });

  after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("survives a restart", async () => {
    const path = join(directory, "state.json");
    const first = new JsonFileRepository(path);
    await first.saveLastKnownGood(
      "c_test",
      [{ name: "n", sku: "S-1", price: 1.5, availability: "in_stock" }],
      "2026-08-21T00:00:00Z",
    );

    const second = new JsonFileRepository(path);
    const snapshot = await second.getLastKnownGood("c_test");
    assert.equal(snapshot?.records.length, 1);
    assert.equal(snapshot?.collectedAt, "2026-08-21T00:00:00Z");
  });

  it("starts empty on corrupt state instead of throwing", async () => {
    const path = join(directory, "corrupt.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, "{{{", "utf8");
    const repository = new JsonFileRepository(path);
    assert.equal(await repository.getLastKnownGood("c_test"), null);
  });

  it("rejects state that is valid JSON but the wrong shape", async () => {
    const { writeFileSync } = await import("node:fs");
    const shapes = [
      JSON.stringify([1, 2, 3]),
      JSON.stringify({ catalog: "nope", events: "nope" }),
      JSON.stringify({ catalog: { c_test: { records: "not-an-array", collectedAt: "x" } } }),
      JSON.stringify({ catalog: { c_test: { records: [] } } }),
      JSON.stringify({ events: [null, 5, { noCollectorId: true }] }),
    ];

    for (const [index, contents] of shapes.entries()) {
      const path = join(directory, `shape-${String(index)}.json`);
      writeFileSync(path, contents, "utf8");
      const repository = new JsonFileRepository(path);
      // Must not throw here, which is where a bad shape used to surface.
      assert.equal(await repository.getLastKnownGood("c_test"), null, contents);
      assert.deepEqual(await repository.listEvents("c_test"), []);
    }
  });

  it("remembers a learned contract across a restart", async () => {
    const path = join(directory, "contract.json");
    const contract = profileContract([
      { title: "Dune", isbn: "9780441013593", pages: 412 },
    ]);

    const first = new JsonFileRepository(path);
    await first.saveContract("c_test", contract);

    const restarted = new JsonFileRepository(path);
    const loaded = await restarted.getContract("c_test");
    assert.deepEqual(loaded, contract);
  });

  it("discards a malformed contract rather than enforcing rules nobody chose", async () => {
    const { writeFileSync } = await import("node:fs");
    const shapes = [
      JSON.stringify({ contracts: { c_test: "nope" } }),
      JSON.stringify({ contracts: { c_test: { version: "one" } } }),
      JSON.stringify({ contracts: { c_test: { version: 1, minimumRows: 1.5 } } }),
      JSON.stringify({ contracts: { c_test: { version: 1, identityField: 42 } } }),
    ];

    for (const [index, contents] of shapes.entries()) {
      const path = join(directory, `contract-shape-${String(index)}.json`);
      writeFileSync(path, contents, "utf8");
      const repository = new JsonFileRepository(path);
      assert.equal(await repository.getContract("c_test"), null, contents);
    }
  });

  it("keeps data written before contracts existed", async () => {
    const { writeFileSync } = await import("node:fs");
    const path = join(directory, "legacy.json");
    // Version 1 stored rows under "catalog".
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        catalog: {
          c_test: {
            records: [{ name: "n", sku: "S-1" }],
            collectedAt: "2026-08-01T00:00:00Z",
          },
        },
        events: [],
      }),
      "utf8",
    );

    const repository = new JsonFileRepository(path);
    const snapshot = await repository.getLastKnownGood("c_test");
    assert.equal(snapshot?.records.length, 1);
    assert.equal(await repository.getContract("c_test"), null);
  });

  it("keeps locks in memory so a stale lock cannot outlive the process", async () => {
    const path = join(directory, "locks.json");
    const first = new JsonFileRepository(path);
    assert.ok(await first.acquire("c_test"));
    assert.equal(await first.acquire("c_test"), null);

    const restarted = new JsonFileRepository(path);
    assert.ok(await restarted.acquire("c_test"), "a restart must not inherit a lock");
  });
});

describe("dashboard rendering", () => {
  const RECORDS = [
    { name: "Motor", sku: "MTR-100", price: 49.95, availability: "in_stock" },
  ];

  const target = {
    id: "demo",
    label: "Demo target",
    collectorId: "c_test",
    targetUrl: "https://example.test/catalog",
    controllable: true,
    records: RECORDS,
    collectedAt: new Date().toISOString(),
    events: [],
    busy: false,
    lastError: null,
    contract: profileContract(RECORDS),
    provisioning: null,
  };

  const page = (state: string, overrides: Record<string, unknown> = {}) =>
    renderDashboardPage({
      configured: true,
      autoHealEnabled: true,
      geminiEnabled: false,
      scheduleMinutes: null,
      canAddTargets: true,
      requiresToken: false,
      targets: [{ ...target, state, ...overrides }],
    } as never);

  it("escapes markup in catalog values", () => {
    const html = page("healthy", {
      records: [
        { name: "<script>alert(1)</script>", sku: "X'1", price: 1, availability: "in_stock" },
      ],
    });
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(html.includes("&#39;"));
  });

  it("shows the collector id, since it is the proof of platform use", () => {
    assert.ok(page("healthy").includes("c_test"));
  });

  it("distinguishes a controlled site from one we do not control", () => {
    assert.match(page("healthy", { controllable: true }), /layout switchable/);
    assert.match(page("healthy", { controllable: false }), /site we do not control/);
  });

  it("renders every orchestration state with a text label", () => {
    const states = [
      "idle",
      "running",
      "healthy",
      "suspected",
      "retry_or_wait",
      "healing",
      "awaiting_approval",
      "verifying",
      "recovered",
      "manual_review",
    ] as const;
    for (const state of states) {
      const html = page(state);
      assert.ok(html.includes("<h1>SupaScraper</h1>"), state);
      assert.ok(/class="value state \w+"/.test(html), state);
    }
  });

  it("flags stale data in every state that withholds an update", () => {
    // Showing last known good data is correct; implying it is current is not.
    const withholding = [
      "suspected",
      "retry_or_wait",
      "healing",
      "awaiting_approval",
      "verifying",
      "manual_review",
    ] as const;

    for (const state of withholding) {
      assert.equal(isShowingStaleData(state, true), true, state);
      assert.match(page(state), /output was withheld/i, state);
    }
  });

  it("does not claim data is stale when it is current", () => {
    for (const state of ["healthy", "recovered", "idle", "running"] as const) {
      assert.equal(isShowingStaleData(state, true), false, state);
      assert.doesNotMatch(page(state), /output was withheld/i, state);
    }
  });

  it("does not flag staleness when there is no data to be stale", () => {
    assert.equal(isShowingStaleData("manual_review", false), false);
  });

  it("renders several targets on one page", () => {
    const html = renderDashboardPage({
      configured: true,
      autoHealEnabled: true,
      geminiEnabled: false,
      scheduleMinutes: 30,
      canAddTargets: true,
      requiresToken: false,
      targets: [
        { ...target, state: "healthy" },
        {
          ...target,
          id: "books",
          label: "Real external site",
          collectorId: "c_other",
          controllable: false,
          state: "recovered",
        },
      ],
    } as never);

    assert.ok(html.includes("Demo target"));
    assert.ok(html.includes("Real external site"));
    assert.ok(html.includes("c_other"));
    assert.match(html, /every 30 min/);
  });

  it("handles the empty and unconfigured cases", () => {
    const empty = renderDashboardPage({
      configured: false,
      autoHealEnabled: false,
      geminiEnabled: false,
      scheduleMinutes: null,
      canAddTargets: true,
      requiresToken: false,
      targets: [],
    } as never);
    assert.match(empty, /No sites yet/);
    assert.ok(empty.includes("auto-repair off"));

    const noData = page("idle", { records: [], collectedAt: null });
    assert.ok(noData.includes("No verified data collected yet"));
    assert.ok(noData.includes("never"));
  });

  it("builds columns from whatever fields the site returned", () => {
    const articles = [
      { headline: "Something happened", byline: "A. Reporter", words: 900 },
    ];
    const html = page("healthy", {
      records: articles,
      contract: profileContract(articles),
    });
    assert.match(html, /<th scope="col">headline<\/th>/);
    assert.match(html, /<th scope="col">byline<\/th>/);
    assert.ok(html.includes("A. Reporter"));
    // Nothing catalog-specific may leak into a site that has no such fields.
    assert.ok(!html.includes(">sku<"));
  });

  it("offers a download for every supported format", () => {
    const html = page("healthy");
    for (const format of EXPORT_FORMATS) {
      assert.ok(
        html.includes(`/api/targets/demo/export?format=${format}`),
        format,
      );
    }
  });

  it("offers no downloads when there is nothing verified to download", () => {
    const html = page("idle", { records: [], collectedAt: null });
    assert.ok(!html.includes("/export?format="));
  });

  it("shows the learned contract, so the guarantee is visible", () => {
    const html = page("healthy");
    assert.match(html, /Learned data contract/);
    assert.match(html, /Rows are identified by/);
  });

  it("says so when no contract has been learned yet", () => {
    const html = page("idle", { records: [], contract: null });
    assert.match(html, /No contract learned yet/);
  });

  it("shows a site whose scraper is still being built", () => {
    const html = page("idle", {
      records: [],
      contract: null,
      provisioning: "Bright Data is building a scraper for this page.",
    });
    assert.match(html, /Building scraper/);
    assert.match(html, /building a scraper/i);
    // Collecting cannot be requested before the scraper exists.
    assert.match(html, /<button data-target="demo" disabled>/);
  });

  it("renders the add-site form when new scrapers can be built", () => {
    const html = page("healthy");
    assert.match(html, /id="add-form"/);
    assert.match(html, /name="url"/);
    assert.match(html, /name="description"/);
  });

  it("explains itself instead of offering a form that cannot work", () => {
    const html = renderDashboardPage({
      configured: true,
      autoHealEnabled: false,
      geminiEnabled: false,
      scheduleMinutes: null,
      canAddTargets: false,
      requiresToken: false,
      targets: [{ ...target, state: "healthy" }],
    } as never);
    assert.ok(!html.includes('id="add-form"'));
    assert.match(html, /needs the Bright Data CLI/);
  });

  it("escapes a hostile field name as well as a hostile value", () => {
    const hostile = [{ "<img src=x onerror=alert(1)>": "value" }];
    const html = page("healthy", {
      records: hostile,
      contract: profileContract(hostile),
    });
    assert.ok(!html.includes("<img src=x"));
    assert.ok(html.includes("&lt;img"));
  });
});

describe("application server", () => {
  let server: Server;
  let base: string;
  let directory: string;
  let runResult: NormalizedRunResult;

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), "supascraper-api-"));
    const config = loadConfig({
      SUPASCRAPER_COLLECTOR_ID: "c_test",
      SUPASCRAPER_TARGET_URL: "https://example.test/catalog",
      SUPASCRAPER_DATA_PATH: join(directory, "state.json"),
    });

    runResult = {
      collectorId: "c_test",
      targetUrl: "https://example.test/catalog",
      startedAt: "2026-08-21T00:00:00Z",
      finishedAt: "2026-08-21T00:00:05Z",
      status: "succeeded",
      records: [{ name: "Motor", sku: "MTR-100", price: 49.95, availability: "in_stock" }],
      extractionErrors: [],
      snapshotId: null,
      safeError: null,
    };

    const repository = new JsonFileRepository(config.dataPath);
    server = createApplicationServer(config, {
      repository,
      runner: { run: () => Promise.resolve(runResult) },
      logger: new ConsoleLogger(),
      targets: new FileTargetRegistry(
        config.targets,
        join(directory, "targets.json"),
        5000,
      ),
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a TCP address");
    }
    base = `http://127.0.0.1:${String(address.port)}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    rmSync(directory, { recursive: true, force: true });
  });

  it("reports health without exposing configuration detail", async () => {
    const body = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    assert.equal(body["status"], "ok");
    assert.equal(body["targets"], 1);
    assert.equal(body["exposed"], false);
  });

  interface TargetView {
    records: unknown[];
    state: string;
    busy: boolean;
    events: { classification: string }[];
  }

  const readStatus = async (): Promise<TargetView> => {
    const body = (await (await fetch(`${base}/api/status`)).json()) as {
      targets: TargetView[];
    };
    const first = body.targets[0];
    if (first === undefined) {
      throw new Error("expected at least one target");
    }
    return first;
  };

  /** The trigger is asynchronous, so settle before asserting on the outcome. */
  const waitForIdle = async (): Promise<Awaited<ReturnType<typeof readStatus>>> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await readStatus();
      if (!status.busy) {
        return status;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("run did not settle");
  };

  it("accepts a run without holding the request open", async () => {
    const response = await fetch(`${base}/api/run`, { method: "POST" });
    assert.equal(response.status, 202);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body["accepted"], true);
  });

  it("publishes verified data once the run settles", async () => {
    await fetch(`${base}/api/run`, { method: "POST" });
    const status = await waitForIdle();
    assert.equal(status.records.length, 1);
    assert.equal(status.state, "healthy");
    assert.equal(status.events[0]?.classification, "healthy");
  });

  it("does not overwrite last known good data when a run breaks", async () => {
    runResult = {
      ...runResult,
      records: [],
      extractionErrors: [
        {
          message: 'Crawler error: waiting for selector ".product-detail" failed: timeout',
          code: null,
          kind: "selector_timeout",
        },
      ],
    };

    await fetch(`${base}/api/run`, { method: "POST" });
    const status = await waitForIdle();

    assert.equal(status.events[0]?.classification, "structural_break");
    assert.equal(status.records.length, 1, "previous verified data must survive");
    assert.equal(status.state, "suspected");
  });

  it("refuses a second trigger while one is in flight", async () => {
    // A slow runner keeps the first request active long enough to collide.
    const slowServer = createApplicationServer(
      loadConfig({
        SUPASCRAPER_COLLECTOR_ID: "c_test",
        SUPASCRAPER_TARGET_URL: "https://example.test/catalog",
        SUPASCRAPER_DATA_PATH: join(directory, "busy.json"),
      }),
      {
        repository: new JsonFileRepository(join(directory, "busy.json")),
        runner: {
          run: () =>
            new Promise((resolve) => {
              setTimeout(() => resolve(runResult), 300);
            }),
        },
        logger: { info: () => undefined, error: () => undefined },
        targets: new FileTargetRegistry(
          loadConfig({
            SUPASCRAPER_COLLECTOR_ID: "c_test",
            SUPASCRAPER_TARGET_URL: "https://example.test/catalog",
          }).targets,
          join(directory, "busy-targets.json"),
          5000,
        ),
      },
    );

    await new Promise<void>((resolve, reject) => {
      slowServer.once("error", reject);
      slowServer.listen(0, "127.0.0.1", resolve);
    });
    const address = slowServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a TCP address");
    }
    const slowBase = `http://127.0.0.1:${String(address.port)}`;

    try {
      const first = await fetch(`${slowBase}/api/run`, { method: "POST" });
      const second = await fetch(`${slowBase}/api/run`, { method: "POST" });
      assert.equal(first.status, 202);
      assert.equal(second.status, 409);

      const body = (await (await fetch(`${slowBase}/api/status`)).json()) as {
        targets: { busy: boolean; state: string }[];
      };
      assert.equal(body.targets[0]?.busy, true);
      assert.equal(body.targets[0]?.state, "running");
    } finally {
      await new Promise<void>((resolve) => {
        slowServer.close(() => resolve());
      });
    }
  });

  it("serves the dashboard and a 404 for unknown paths", async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes("SupaScraper"));
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });

  it("lists the monitored targets", async () => {
    const body = (await (await fetch(`${base}/api/targets`)).json()) as {
      targets: { id: string; collectorId: string }[];
      exportFormats: string[];
    };
    assert.equal(body.targets[0]?.collectorId, "c_test");
    assert.deepEqual(body.exportFormats, [...EXPORT_FORMATS]);
  });

  it("exports verified data in every supported format", async () => {
    for (const format of EXPORT_FORMATS) {
      const response = await fetch(
        `${base}/api/targets/primary/export?format=${format}`,
      );
      assert.equal(response.status, 200, format);
      assert.match(
        response.headers.get("content-disposition") ?? "",
        /^attachment; filename="[^"]+"$/,
        format,
      );
      const text = await response.text();
      assert.ok(text.length > 0, format);
      assert.ok(text.includes("MTR-100"), format);
    }
  });

  it("exports JSON that parses back into the verified rows", async () => {
    const response = await fetch(`${base}/api/targets/primary/export?format=json`);
    const rows = (await response.json()) as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.["sku"], "MTR-100");
  });

  it("exports CSV with a header row and quoted separators", async () => {
    const text = await (
      await fetch(`${base}/api/targets/primary/export?format=csv`)
    ).text();
    const [header, first] = text.split("\r\n");
    assert.ok(header?.includes("sku"), header);
    assert.ok(first?.includes("MTR-100"), first);
  });

  it("defaults to JSON when no format is given", async () => {
    const response = await fetch(`${base}/api/targets/primary/export`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  });

  it("refuses an unsupported export format", async () => {
    const response = await fetch(`${base}/api/targets/primary/export?format=exe`);
    assert.equal(response.status, 400);
    const body = (await response.json()) as { supported: string[] };
    assert.deepEqual(body.supported, [...EXPORT_FORMATS]);
  });

  it("returns 404 when exporting a target that does not exist", async () => {
    const response = await fetch(`${base}/api/targets/nope/export?format=csv`);
    assert.equal(response.status, 404);
  });

  it("cannot build new scrapers when no factory is available", async () => {
    const response = await fetch(`${base}/api/targets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/products",
        description: "Extract the product title and price for each item.",
      }),
    });
    assert.equal(response.status, 503);
  });
});

describe("adding a site over HTTP", () => {
  let server: Server;
  let base: string;
  let directory: string;
  let created: { url: string; description: string; name: string }[];
  let failNext: boolean;

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), "supascraper-add-"));
    created = [];
    failNext = false;

    const config = loadConfig({
      SUPASCRAPER_DATA_PATH: join(directory, "state.json"),
    });

    server = createApplicationServer(config, {
      repository: new JsonFileRepository(config.dataPath),
      runner: {
        run: () =>
          Promise.resolve({
            collectorId: "c_new",
            targetUrl: "https://example.com/products",
            startedAt: "2026-08-22T00:00:00Z",
            finishedAt: "2026-08-22T00:00:05Z",
            status: "succeeded" as const,
            records: [{ title: "Widget", price: 9.99 }],
            extractionErrors: [],
            snapshotId: null,
            safeError: null,
          }),
      },
      logger: { info: () => undefined, error: () => undefined },
      targets: new FileTargetRegistry([], join(directory, "targets.json"), 5000),
      factory: {
        create: (input) => {
          created.push(input);
          return failNext
            ? Promise.reject(new Error("AI generation failed"))
            : Promise.resolve({ collectorId: "c_new" });
        },
      },
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a TCP address");
    }
    base = `http://127.0.0.1:${String(address.port)}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    rmSync(directory, { recursive: true, force: true });
  });

  const add = (body: unknown): Promise<Response> =>
    fetch(`${base}/api/targets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const waitForTarget = async (id: string): Promise<Record<string, unknown>> => {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const body = (await (await fetch(`${base}/api/status`)).json()) as {
        targets: Record<string, unknown>[];
      };
      const found = body.targets.find((target) => target["id"] === id);
      if (found !== undefined && found["provisioning"] === null && !found["busy"]) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`target ${id} never settled`);
  };

  it("accepts a public page and answers before the scraper is built", async () => {
    const response = await add({
      url: "https://example.com/products",
      description: "For each product card, extract the title and the price as a number.",
      label: "Example shop",
    });

    assert.equal(response.status, 202);
    const body = (await response.json()) as { target: Record<string, unknown> };
    assert.equal(body.target["status"], "building");
    assert.equal(body.target["id"], "example-com-products");
    assert.equal(body.target["label"], "Example shop");
  });

  it("builds the scraper, collects, and learns a contract without being asked", async () => {
    const target = await waitForTarget("example-com-products");

    assert.equal(created.length, 1);
    assert.equal(created[0]?.url, "https://example.com/products");
    assert.equal(target["collectorId"], "c_new");
    assert.deepEqual(target["records"], [{ title: "Widget", price: 9.99 }]);

    const contract = target["contract"] as { requiredFields: string[] } | null;
    assert.ok(contract);
    assert.deepEqual([...contract.requiredFields].sort(), ["price", "title"]);
  });

  it("exports the newly added site's data", async () => {
    const text = await (
      await fetch(`${base}/api/targets/example-com-products/export?format=csv`)
    ).text();
    assert.match(text, /title/);
    assert.match(text, /Widget/);
  });

  it("refuses the same page twice", async () => {
    const response = await add({
      url: "https://example.com/products",
      description: "For each product card, extract the title and the price as a number.",
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /already being monitored/);
  });

  it("rejects input that could not produce a working scraper", async () => {
    const cases: [unknown, RegExp][] = [
      [{ url: "", description: "Extract the title and price of each item." }, /required/],
      [{ url: "not-a-url", description: "Extract the title and price of each item." }, /valid URL/],
      [{ url: "http://example.org/x", description: "Extract the title and price." }, /https/],
      [{ url: "https://example.org/x", description: "too short" }, /at least/],
      [{ url: "https://example.org/x", description: "y".repeat(501) }, /at most/],
    ];

    for (const [body, expected] of cases) {
      const response = await add(body);
      assert.equal(response.status, 400, JSON.stringify(body));
      const parsed = (await response.json()) as { error: string };
      assert.match(parsed.error, expected);
    }
  });

  it("refuses an address that is not a public website", async () => {
    const privateUrls = [
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://10.1.2.3/x",
      "https://192.168.0.5/x",
      "https://172.16.4.4/x",
      "https://169.254.169.254/latest/meta-data",
      "https://metadata.google.internal/x",
      "https://[::1]/x",
      "https://box.internal/x",
    ];

    for (const url of privateUrls) {
      const response = await add({
        url,
        description: "Extract the title and price of each item on the page.",
      });
      assert.equal(response.status, 400, url);
      const parsed = (await response.json()) as { error: string };
      assert.match(parsed.error, /public/i, url);
    }
  });

  it("refuses credentials embedded in the URL", async () => {
    const response = await add({
      url: "https://user:secret@example.org/x",
      description: "Extract the title and price of each item on the page.",
    });
    assert.equal(response.status, 400);
    const parsed = (await response.json()) as { error: string };
    assert.match(parsed.error, /credentials/i);
  });

  it("refuses an oversized request body", async () => {
    const response = await add({
      url: "https://example.org/x",
      description: "d".repeat(20_000),
    });
    assert.equal(response.status, 400);
  });

  it("refuses a body that is not JSON", async () => {
    const response = await fetch(`${base}/api/targets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{{{",
    });
    assert.equal(response.status, 400);
  });

  it("records a build failure against the site instead of losing it", async () => {
    failNext = true;
    const response = await add({
      url: "https://example.net/catalogue",
      description: "Extract each listing's name and price from the catalogue page.",
    });
    assert.equal(response.status, 202);

    for (let attempt = 0; attempt < 150; attempt += 1) {
      const body = (await (await fetch(`${base}/api/status`)).json()) as {
        targets: Record<string, unknown>[];
      };
      const found = body.targets.find((t) => t["id"] === "example-net-catalogue");
      if (found?.["lastError"] === "AI generation failed") {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("the failure was never reported");
  });
});

describe("configuration safety", () => {
  it("refuses a non-loopback bind without a strong api token", () => {
    assert.throws(
      () => loadConfig({ SUPASCRAPER_HOST: "0.0.0.0" }),
      /requires SUPASCRAPER_API_TOKEN/,
    );
    assert.throws(
      () => loadConfig({ SUPASCRAPER_HOST: "0.0.0.0", SUPASCRAPER_API_TOKEN: "short" }),
      /requires SUPASCRAPER_API_TOKEN/,
    );
  });

  it("allows a non-loopback bind once a token is supplied", () => {
    const config = loadConfig({
      SUPASCRAPER_HOST: "0.0.0.0",
      SUPASCRAPER_API_TOKEN: "a-sufficiently-long-token",
    });
    assert.equal(config.host, "0.0.0.0");
  });

  it("defaults to loopback", () => {
    assert.equal(loadConfig({}).host, "127.0.0.1");
  });
});

describe("transport failures observed in real runs", () => {
  it("recognizes the navigation failure Bright Data actually emits", () => {
    // Observed live on 2026-08-22. A marker list built from assumptions missed
    // this and fell through to "unknown".
    assert.equal(
      classifyExtractionError(
        "Crawler error: Navigation failed: Network connection was closed by other party.",
        null,
      ),
      "unreachable_page",
    );
  });

  it("recognizes the common socket and connection failures", () => {
    const transport = [
      "Navigation failed: connection refused",
      "socket hang up",
      "ECONNRESET while loading",
      "ECONNREFUSED 10.0.0.1:443",
      "connection reset by peer",
    ];
    for (const message of transport) {
      assert.equal(classifyExtractionError(message, null), "unreachable_page", message);
    }
  });

  it("still treats a mixed run as structural when a selector genuinely failed", () => {
    // A run can carry both kinds. Selector evidence proves the page loaded at
    // least once, so a repair is warranted.
    const mixed = [
      classifyExtractionError("Navigation failed: Network connection was closed", null),
      classifyExtractionError(
        'waiting for selector ".product-detail" failed: timeout 30000ms exceeded',
        null,
      ),
    ];
    assert.deepEqual(mixed, ["unreachable_page", "selector_timeout"]);
  });
});
