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
import { createApplicationServer } from "../dist/presentation/api/server.js";
import {
  isShowingStaleData,
  renderDashboardPage,
} from "../dist/presentation/web/dashboard-page.js";
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
  const base = {
    configured: true,
    collectorId: "c_test",
    targetUrl: "https://example.test/catalog",
    records: [{ name: "Motor", sku: "MTR-100", price: 49.95, availability: "in_stock" as const }],
    collectedAt: new Date().toISOString(),
    events: [],
  };

  it("escapes markup in catalog values", () => {
    const html = renderDashboardPage({
      ...base,
      state: "healthy",
      records: [
        { name: "<script>alert(1)</script>", sku: "X'1", price: 1, availability: "in_stock" },
      ],
    });
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(html.includes("&#39;"));
  });

  it("shows the collector id, since it is the proof of platform use", () => {
    assert.ok(renderDashboardPage({ ...base, state: "healthy" }).includes("c_test"));
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
      const html = renderDashboardPage({ ...base, state });
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
      assert.match(renderDashboardPage({ ...base, state }), /output was withheld/i, state);
    }
  });

  it("does not claim data is stale when it is current", () => {
    for (const state of ["healthy", "recovered", "idle", "running"] as const) {
      assert.equal(isShowingStaleData(state, true), false, state);
      assert.doesNotMatch(
        renderDashboardPage({ ...base, state }),
        /output was withheld/i,
        state,
      );
    }
  });

  it("does not flag staleness when there is no data to be stale", () => {
    assert.equal(isShowingStaleData("manual_review", false), false);
  });

  it("handles the empty and unconfigured cases", () => {
    const empty = renderDashboardPage({
      ...base,
      configured: false,
      collectorId: null,
      records: [],
      collectedAt: null,
      state: "idle",
    });
    assert.ok(empty.includes("No verified catalog data"));
    assert.ok(empty.includes("No collector configured"));
    assert.ok(empty.includes("never"));
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
    assert.equal(body["collectorConfigured"], true);
    assert.equal(body["exposed"], false);
  });

  it("publishes verified data through a manual run", async () => {
    const response = await fetch(`${base}/api/run`, { method: "POST" });
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(response.status, 200);
    assert.equal(body["classification"], "healthy");
    assert.equal(body["published"], true);

    const status = (await (await fetch(`${base}/api/status`)).json()) as {
      records: unknown[];
      state: string;
    };
    assert.equal(status.records.length, 1);
    assert.equal(status.state, "healthy");
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

    const response = await fetch(`${base}/api/run`, { method: "POST" });
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body["classification"], "structural_break");
    assert.equal(body["published"], false);

    const status = (await (await fetch(`${base}/api/status`)).json()) as {
      records: unknown[];
      state: string;
    };
    assert.equal(status.records.length, 1, "previous verified data must survive");
    assert.equal(status.state, "suspected");
  });

  it("serves the dashboard and a 404 for unknown paths", async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes("SupaScraper"));
    assert.equal((await fetch(`${base}/nope`)).status, 404);
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
