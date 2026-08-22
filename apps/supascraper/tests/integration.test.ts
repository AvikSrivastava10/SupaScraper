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
  groupEvents,
  isShowingStaleData,
  renderDashboardPage,
} from "../dist/presentation/web/dashboard-page.js";
import {
  isScraperTab,
  renderScraperPage,
  SCRAPER_TABS,
} from "../dist/presentation/web/scraper-page.js";
import {
  renderActivityPage,
  renderDataPage,
  renderScrapersPage,
  renderSettingsPage,
} from "../dist/presentation/web/list-pages.js";
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

  it("recognizes the proxy refusal Bright Data actually emits", () => {
    // Observed live on 2026-08-22 against a user-supplied site. This previously
    // fell through to "unknown" and the dashboard said "unrecognized extraction
    // failure", which hid the only fact that mattered: nothing reached the site.
    assert.equal(
      classifyExtractionError(
        "Crawler error: tunneling socket could not be established, statusCode=407",
        null,
      ),
      "proxy_error",
    );
  });

  it("recognizes the other proxy failure spellings", () => {
    const proxyFailures = [
      "tunneling socket could not be established",
      "Proxy Authentication Required",
      "net::ERR_TUNNEL_CONNECTION_FAILED",
      "statusCode=407",
    ];
    for (const message of proxyFailures) {
      assert.equal(classifyExtractionError(message, null), "proxy_error", message);
    }
    assert.equal(classifyExtractionError("anything", "proxy_error"), "proxy_error");
  });

  it("does not mistake a proxy refusal for a dead page", () => {
    // Both mention a status code, but one means "fix your URL" and the other
    // means "fix your Bright Data account". Conflating them misdirects the reader.
    assert.notEqual(
      classifyExtractionError("tunneling socket could not be established, statusCode=407", null),
      "unreachable_page",
    );
    assert.equal(
      classifyExtractionError("The navigation resulted in a dead page (404 status code)", null),
      "unreachable_page",
    );
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

const RECORDS = [
  { name: "Motor", sku: "MTR-100", price: 49.95, availability: "in_stock" },
];

const target = {
  id: "demo",
  label: "Demo target",
  collectorId: "c_test",
  targetUrl: "https://example.test/catalog",
  fieldDescription: "Extract product name, SKU, numeric price, and availability.",
  controllable: true,
  records: RECORDS,
  collectedAt: new Date().toISOString(),
  events: [] as unknown[],
  busy: false,
  lastError: null,
  contract: profileContract(RECORDS),
  provisioning: null,
  steps: [] as unknown[],
  health: {
    extraction: 1,
    schema: 1,
    freshness: null,
    overall: 1,
    checkedAt: new Date().toISOString(),
  },
};

/** One recorded pipeline step, as the activity log emits them. */
const step = (overrides: Record<string, unknown> = {}) => ({
  stage: "collect",
  status: "done",
  detail: "The collector finished and returned output.",
  at: new Date().toISOString(),
  ...overrides,
});

/** A recorded run, shaped like the events the orchestrator appends. */
const event = (overrides: Record<string, unknown> = {}) => ({
  id: "1",
  collectorId: "c_test",
  targetUrl: "https://example.test/catalog",
  state: "healthy",
  classification: "healthy",
  confidence: 1,
  evidence: ["All 1 row(s) satisfy the expected contract."],
  beforeMetrics: { rowCount: 1, validRowCount: 1, missingByField: {}, nullByField: {} },
  afterMetrics: null,
  healPrompt: null,
  commandOutcome: null,
  verification: "not_started",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

const status = (overrides: Record<string, unknown> = {}) =>
  ({
    configured: true,
    autoHealEnabled: true,
    geminiEnabled: false,
    scheduleMinutes: null,
    canAddTargets: true,
    requiresToken: false,
    targets: [target],
    ...overrides,
  }) as never;

describe("scraper detail page", () => {
  const detail = (tab: string, overrides: Record<string, unknown> = {}) =>
    renderScraperPage({ ...target, ...overrides } as never, tab as never, status());

  it("offers all four sections, with the current one marked", () => {
    const html = detail("overview");
    for (const label of ["Overview", "Data", "Contract", "Activity"]) {
      assert.ok(html.includes(`>${label}</a>`), label);
    }
    assert.match(html, /href="\/scrapers\/demo"[^>]*aria-current="page"/);
  });

  it("accepts every tab name", () => {
    for (const tab of SCRAPER_TABS) {
      assert.equal(isScraperTab(tab), true, tab);
      assert.ok(detail(tab).includes("<h1"), tab);
    }
    assert.equal(isScraperTab("nonsense"), false);
  });

  it("shows the plain-language request the extractor was built from", () => {
    const html = detail("overview");
    assert.match(html, /Extract product name, SKU, numeric price, and availability\./);
    assert.match(html, /every repair reuses this same id/);
  });

  it("distinguishes a controlled site from one we do not control", () => {
    assert.match(detail("overview", { controllable: true }), /layout switchable/);
    assert.match(detail("overview", { controllable: false }), /site we do not control/);
  });

  it("builds data columns from whatever fields the site returned", () => {
    const articles = [{ headline: "Something happened", byline: "A. Reporter", words: 900 }];
    const html = detail("data", {
      records: articles,
      contract: profileContract(articles),
    });
    assert.match(html, /<th scope="col">headline<\/th>/);
    assert.match(html, /<th scope="col">byline<\/th>/);
    assert.ok(html.includes("A. Reporter"));
    // Nothing catalog-specific may leak into a site that has no such fields.
    assert.ok(!html.includes(">sku<"));
  });

  it("escapes markup in scraped values and field names", () => {
    const hostile = [{ "<img src=x onerror=alert(1)>": "<script>alert(1)</script>" }];
    const html = detail("data", {
      records: hostile,
      contract: profileContract(hostile),
    });
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.ok(!html.includes("<img src=x"));
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(html.includes("&lt;img"));
  });

  it("says plainly when there is nothing verified to show", () => {
    const html = detail("data", { records: [], collectedAt: null });
    assert.match(html, /No verified data collected yet/);
    assert.ok(!html.includes("/export?format="));
  });

  it("offers a download for every supported format", () => {
    const html = detail("data");
    for (const format of EXPORT_FORMATS) {
      assert.ok(html.includes(`/api/targets/demo/export?format=${format}`), format);
    }
  });

  it("spells out the rules the contract enforces", () => {
    const html = detail("contract");
    assert.match(html, /must be present and non-empty in every row/);
    assert.match(html, /must keep the type it was learned with/);
    assert.match(html, /must be unique/);
    assert.match(html, /field\(s\) monitored/);
  });

  it("reports schema integrity as a measured figure", () => {
    const html = detail("contract");
    assert.match(html, /fields intact/);
    assert.match(html, /drift events/);
    assert.match(html, /verified repairs/);
  });

  it("separates self-healing events from ordinary scrapes", () => {
    const html = detail("activity", {
      events: [
        event({
          classification: "structural_break",
          state: "suspected",
          healPrompt: "Re-extract the price.",
          evidence: ["price is missing."],
        }),
      ],
    });
    assert.match(html, /Self-healing events/);
    assert.match(html, /Schema drift detected/);
    assert.match(html, /Repair instruction sent to Scraper Studio/);
    assert.match(html, /Re-extract the price\./);
  });

  it("says so when a site has never drifted", () => {
    const html = detail("activity", { events: [event()] });
    assert.match(html, /No schema drift has been detected/);
  });

  it("reads run metrics as a sentence rather than as 0\/0", () => {
    const empty = detail("activity", {
      events: [
        event({ beforeMetrics: { rowCount: 0, validRowCount: 0, missingByField: {}, nullByField: {} } }),
      ],
    });
    assert.match(empty, /no rows returned/);
    assert.ok(!empty.includes("0/0 valid"));

    const partial = detail("activity", {
      events: [
        event({ beforeMetrics: { rowCount: 4, validRowCount: 1, missingByField: {}, nullByField: {} } }),
      ],
    });
    assert.match(partial, /1 of 4 row\(s\) valid/);
  });

  it("shows the full step sequence, not a truncated one", () => {
    const html = detail("activity", {
      steps: [
        step({ stage: "validate", status: "done" }),
        step({ stage: "build_scraper", status: "done" }),
        step({ stage: "collect", status: "done" }),
        step({ stage: "read_output", status: "done" }),
        step({ stage: "check_contract", status: "done" }),
        step({ stage: "classify", status: "done" }),
        step({ stage: "learn_contract", status: "done" }),
        step({ stage: "publish", status: "done" }),
      ],
    });
    assert.match(html, /Request accepted/);
    assert.match(html, /Extractor built/);
    assert.match(html, /Data published/);
  });

  it("links back to the list", () => {
    assert.match(detail("overview"), /href="\/scrapers"/);
  });
});

describe("list pages", () => {
  it("lists every scraper with its health", () => {
    const html = renderScrapersPage(status());
    assert.match(html, /Demo target/);
    assert.match(html, /<th scope="col">Health<\/th>/);
    assert.match(html, /href="\/scrapers\/demo"/);
  });

  it("says so when there is nothing to list", () => {
    assert.match(renderScrapersPage(status({ targets: [] })), /No scrapers yet/);
  });

  it("merges activity across scrapers, newest first", () => {
    const older = { ...target, id: "a", label: "Older" };
    const newer = { ...target, id: "b", label: "Newer" };
    const html = renderActivityPage(
      status({
        targets: [
          { ...older, events: [event({ createdAt: "2026-08-22T01:00:00Z" })] },
          { ...newer, events: [event({ createdAt: "2026-08-22T02:00:00Z" })] },
        ],
      }),
    );
    assert.ok(html.indexOf("Newer") < html.indexOf("Older"), "newest must come first");
    assert.match(html, /verified repairs/);
  });

  it("shows verified data per scraper on the data page", () => {
    const html = renderDataPage(status());
    assert.match(html, /verified record\(s\) across/);
    assert.match(html, /MTR-100/);
    assert.match(html, /export\?format=csv/);
  });

  it("says so when nothing has been verified", () => {
    assert.match(renderDataPage(status({ targets: [] })), /Nothing verified yet/);
  });

  it("reports configuration without revealing a secret", () => {
    const html = renderSettingsPage(
      status({ geminiEnabled: true, requiresToken: true, scheduleMinutes: 30 }),
    );
    assert.match(html, /Automatic repair/);
    assert.match(html, /Gemini second opinion/);
    assert.match(html, /Every <strong>30<\/strong> minutes/);
    assert.match(html, /48<\/strong> scrapes per scraper per day/);
    // How health is derived must be stated, not left as a magic number.
    assert.match(html, /How health is measured/);

    // The real guarantee is structural: the view model carries no secret to
    // leak. Capabilities are booleans, so the page can only ever say on or off.
    const model = status() as unknown as Record<string, unknown>;
    for (const key of ["autoHealEnabled", "geminiEnabled", "canAddTargets", "requiresToken"]) {
      assert.equal(typeof model[key], "boolean", key);
    }
    assert.ok(!Object.keys(model).some((key) => /key|token|secret|password/i.test(key) && typeof model[key] === "string"));
  });

  it("says there is no schedule when none is set", () => {
    assert.match(renderSettingsPage(status()), /No unattended scrapes/);
  });
});

describe("dashboard rendering", () => {
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

  it("escapes markup in a scraper's own name", () => {
    const html = page("healthy", { label: "<script>alert(1)</script>" });
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.ok(html.includes("&lt;script&gt;"));
  });

  it("does not put raw scraped rows on the dashboard at all", () => {
    // The dashboard is about the health of each extractor. The rows live on the
    // scraper's own page, which is what keeps this screen readable.
    const html = page("healthy");
    assert.ok(!html.includes("<th scope="), "no data table belongs on the dashboard");
    assert.ok(!html.includes("MTR-100"), "scraped values belong on the scraper's page");
  });

  it("shows the collector id, since it is the proof of platform use", () => {
    assert.ok(page("healthy").includes("c_test"));
  });

  it("leads with the product's claim, not with a form", () => {
    const html = page("healthy");
    assert.match(html, /Self-healing web intelligence/);
    assert.match(html, /Your scraper shouldn't break when the web changes\./);
    // The call to action comes first; the form is behind it.
    assert.match(html, /id="reveal-form"/);
    assert.match(html, /\+ Add a website/);
  });

  it("keeps the create form collapsed until it is asked for", () => {
    const html = page("healthy");
    // A large form is the wrong first impression for a monitoring product.
    assert.match(html, /id="create-panel"[^>]*hidden/);
    assert.match(html, /aria-expanded="false"/);
  });

  it("names the three capabilities under the hero", () => {
    const html = page("healthy");
    for (const capability of ["Auto-healing", "Data validation", "Schema monitoring"]) {
      assert.ok(html.includes(capability), capability);
    }
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
      assert.ok(/class="status \w+"/.test(html), state);
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
  });

  it("summarizes the fleet before the individual scrapers", () => {
    const html = page("healthy");
    for (const caption of ["scrapers", "fleet health", "records", "fields monitored", "self-repairs"]) {
      assert.ok(html.includes(caption), caption);
    }
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
    assert.match(empty, /No scrapers yet/);

    const noData = page("idle", { records: [], collectedAt: null });
    assert.ok(noData.includes("never"));
    assert.ok(!noData.includes("/export?format="));
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

  it("shows the learned contract on the card, so the guarantee is visible", () => {
    const html = page("healthy");
    assert.match(html, /Data contract/);
    assert.match(html, /row identity/);
    // Field names carry their learned type.
    assert.match(html, /<span class="name">price<\/span>/);
  });

  it("says so when no contract has been learned yet", () => {
    const html = page("idle", { records: [], contract: null });
    assert.match(html, /No contract yet/);
  });

  it("shows health as measured components, not just a badge", () => {
    const html = page("healthy");
    for (const label of ["Extraction", "Schema", "Freshness"]) {
      assert.ok(html.includes(label), label);
    }
    assert.match(html, /Last checked/);
  });

  it("shows a dash for a health component it could not measure", () => {
    // Freshness is unmeasurable without a schedule, and a flattering default
    // would be a lie about a question nobody asked.
    const html = page("healthy");
    assert.match(html, /<span class="v">—<\/span>/);
  });

  it("shows a site whose extractor is still being built", () => {
    const html = page("idle", {
      records: [],
      contract: null,
      provisioning: "Bright Data is building the extractor for this page.",
    });
    assert.match(html, /Building/);
    assert.match(html, /building the extractor/i);
    // Scraping cannot be requested before the extractor exists.
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
    assert.match(html, /Bright Data CLI is not reachable/);
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

  it("keeps the palette to greys plus a small, deliberate set of hues", () => {
    // Structure is carried by greys so the page stays calm; a handful of hues
    // carry meaning. Without a bound, "one accent" quietly becomes a rainbow.
    const html = page("healthy");
    const channels = (hex: string): [number, number, number] => [
      Number.parseInt(hex.slice(1, 3), 16),
      Number.parseInt(hex.slice(3, 5), 16),
      Number.parseInt(hex.slice(5, 7), 16),
    ];

    const hues = new Set(
      [...html.matchAll(/#[0-9a-f]{6}\b/gi)]
        .map((match) => match[0].toLowerCase())
        .filter((colour) => {
          const [r, g, b] = channels(colour);
          return !(r === g && g === b);
        }),
    );

    assert.ok(hues.size > 0, "expected at least one accent");
    assert.ok(hues.size <= 8, `too many hues: ${[...hues].join(", ")}`);
  });

  it("uses green for health, red for failure, and blue only for times", () => {
    const html = page("healthy");
    const channelsOf = (name: string): [number, number, number] => {
      const found = new RegExp(`${name}:(#[0-9a-f]{6})`, "i").exec(html);
      assert.ok(found?.[1], `${name} is not declared`);
      const hex = found[1];
      return [
        Number.parseInt(hex.slice(1, 3), 16),
        Number.parseInt(hex.slice(3, 5), 16),
        Number.parseInt(hex.slice(5, 7), 16),
      ];
    };

    const [gr, gg, gb] = channelsOf("--good");
    assert.ok(gg > gr && gg > gb, "health accent must be green");

    const [br, bg, bb] = channelsOf("--bad");
    assert.ok(br > bg && br > bb, "failure accent must be red");

    const [tr, tg, tb] = channelsOf("--time");
    assert.ok(tb > tr && tb > tg, "time accent must be blue");
  });

  it("puts the page on white with near-black type", () => {
    const html = page("healthy");
    assert.match(html, /--paper:#ffffff/);
    assert.match(html, /--ink:#0a0a0a/);
    assert.match(html, /color-scheme: light/);
  });

  it("draws surfaces with crisp single-pixel borders and no shadows", () => {
    const html = page("healthy");
    assert.match(html, /\.panel \{ background:var\(--paper\); border:1px solid var\(--line\)/);
    assert.ok(!/box-shadow/.test(html), "shadows soften the straight lines asked for");
  });

  it("explains a proxy failure instead of showing a bare status code", () => {
    const html = page("manual_review", {
      records: [],
      collectedAt: null,
      events: [
        event({
          classification: "transient_error",
          state: "manual_review",
          evidence: [
            "Bright Data's proxy refused the connection, so the page was never requested.",
            "This is an account, zone, or network problem rather than a scraper problem.",
            "Crawler error: tunneling socket could not be established, statusCode=407",
          ],
        }),
      ],
    });

    assert.match(html, /proxy refused the connection/i);
    assert.match(html, /Nothing was repaired, because nothing reached the site/i);
  });

  it("counts schema drift on the card", () => {
    const html = page("suspected", {
      events: [
        event({ classification: "structural_break", state: "suspected" }),
        event({ id: "0", classification: "healthy", state: "healthy" }),
      ],
    });
    assert.match(html, /Schema drift events: <strong>1<\/strong>/);
  });

  it("tells the reader what to do when a break needs a repair", () => {
    const withHeal = page("suspected", {
      events: [event({ classification: "structural_break", state: "suspected" })],
    });
    assert.match(withHeal, /repair should start on its own/i);

    const withoutHeal = renderDashboardPage({
      configured: true,
      autoHealEnabled: false,
      geminiEnabled: false,
      scheduleMinutes: null,
      canAddTargets: true,
      requiresToken: false,
      targets: [
        {
          ...target,
          state: "suspected",
          events: [event({ classification: "structural_break", state: "suspected" })],
        },
      ],
    } as never);
    assert.match(withoutHeal, /SUPASCRAPER_AUTO_HEAL=true/);
  });

  it("says plainly that a site has never been scraped", () => {
    const html = page("idle", { records: [], collectedAt: null, events: [] });
    assert.match(html, /Never scraped/);
    assert.match(html, /Choose Scrape now/);
  });

  it("links each card to its own scraper page", () => {
    const html = page("healthy");
    assert.match(html, /href="\/scrapers\/demo"/);
    assert.match(html, /Open &rarr;/);
  });

  it("offers the same navigation on every page", () => {
    const html = page("healthy");
    for (const item of ["Dashboard", "Scrapers", "Activity", "Data", "Settings"]) {
      assert.ok(html.includes(`>${item}</a>`), item);
    }
    assert.match(html, /aria-current="page"/);
  });
});

describe("pipeline visibility", () => {
  const page = (overrides: Record<string, unknown> = {}) =>
    renderDashboardPage({
      configured: true,
      autoHealEnabled: true,
      geminiEnabled: false,
      scheduleMinutes: null,
      canAddTargets: true,
      requiresToken: false,
      targets: [{ ...target, state: "healthy", ...overrides }],
    } as never);

  it("names every step it takes, in order", () => {
    const html = page({
      steps: [
        step({ stage: "validate", status: "done" }),
        step({ stage: "build_scraper", status: "done" }),
        step({ stage: "collect", status: "done" }),
        step({ stage: "read_output", status: "done" }),
        step({ stage: "check_contract", status: "done" }),
        step({ stage: "classify", status: "done" }),
        step({ stage: "learn_contract", status: "done" }),
        step({ stage: "publish", status: "done" }),
      ],
    });

    // The card keeps only the most recent steps so it stays compact; the full
    // sequence is on the scraper's own page.
    const expected = [
      "Scrape completed",
      "Output read",
      "Data validated",
      "Run classified",
      "Data contract learned",
      "Data published",
    ];

    let cursor = -1;
    for (const label of expected) {
      const at = html.indexOf(label);
      assert.ok(at > -1, `missing step: ${label}`);
      assert.ok(at > cursor, `step out of order: ${label}`);
      cursor = at;
    }
  });

  it("names the repair steps too, since a repair runs unattended for minutes", () => {
    const html = page({
      steps: [
        step({ stage: "heal", status: "done" }),
        step({ stage: "review_fix", status: "done" }),
        step({ stage: "apply_fix", status: "done" }),
        step({ stage: "verify", status: "done" }),
      ],
    });
    assert.match(html, /Repair proposed/);
    assert.match(html, /Proposed fix reviewed/);
    assert.match(html, /Fix applied to the same collector/);
    assert.match(html, /Scraper repaired successfully/);
  });

  it("reads a drift detection as drift, not as a generic failure", () => {
    const html = page({
      steps: [step({ stage: "check_contract", status: "failed" })],
    });
    assert.match(html, /Schema drift detected/);
  });

  it("never lets a withheld publish read like a successful one", () => {
    // The single most dangerous confusion this product can present.
    const withheld = page({ steps: [step({ stage: "publish", status: "skipped" })] });
    assert.match(withheld, /Data withheld/);
    assert.ok(!withheld.includes("Data published"));

    const published = page({ steps: [step({ stage: "publish", status: "done" })] });
    assert.match(published, /Data published/);
    assert.ok(!published.includes("Data withheld"));
  });

  it("does not claim a contract was learned when the step was skipped", () => {
    const html = page({ steps: [step({ stage: "learn_contract", status: "skipped" })] });
    assert.match(html, /Contract already known/);
    assert.ok(!html.includes("Data contract learned"));
  });

  it("marks a step that is still running", () => {
    const html = page({ steps: [step({ stage: "heal", status: "started" })] });
    assert.match(html, /<li class="started">/);
    assert.match(html, /Repair agent activated/);
  });

  it("shows each step's own explanation, not just its name", () => {
    const html = page({
      steps: [
        step({
          stage: "learn_contract",
          status: "done",
          detail: "Learned from this run: title, price, identified by title.",
        }),
      ],
    });
    assert.match(html, /Learned from this run: title, price/);
  });

  it("stamps each step with a clock time, so a sequence can be read", () => {
    const html = page({
      steps: [step({ stage: "collect", at: "2026-08-23T00:42:00Z" })],
    });
    assert.match(html, /<span class="at">\d{2}:\d{2}<\/span>/);
  });

  it("escapes a step detail, since it can carry text from the site", () => {
    const html = page({ steps: [step({ detail: "<script>alert(1)</script>" })] });
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.match(html, /&lt;script&gt;/);
  });

  it("says the steps will appear rather than showing an empty box", () => {
    const html = page({ steps: [] });
    assert.match(html, /Nothing has run yet/);
  });

  it("refreshes faster while a step is mid-flight", () => {
    const moving = page({ busy: true, steps: [step({ status: "started" })] });
    assert.match(moving, /http-equiv="refresh" content="6"/);

    const settled = page({ busy: true, steps: [step({ status: "done" })] });
    assert.match(settled, /http-equiv="refresh" content="15"/);
  });

  it("does not refresh at all when nothing is happening", () => {
    assert.ok(!page({ busy: false, steps: [] }).includes("http-equiv=\"refresh\""));
  });
});

describe("groupEvents", () => {
  it("collapses consecutive runs with the same outcome into one entry", () => {
    // Three identical failures are one fact. Listing each pushed everything
    // useful off the screen, which is what made the page unreadable.
    const repeated = [
      event({ id: "3", createdAt: "2026-08-22T00:02:00Z" }),
      event({ id: "2", createdAt: "2026-08-22T00:01:00Z" }),
      event({ id: "1", createdAt: "2026-08-22T00:00:00Z" }),
    ];
    const grouped = groupEvents(repeated);

    assert.equal(grouped.length, 1);
    assert.equal(grouped[0]?.repeats, 3);
    assert.equal(grouped[0]?.event.id, "3", "the newest event represents the group");
    assert.equal(grouped[0]?.oldestAt, "2026-08-22T00:00:00Z");
  });

  it("keeps entries apart when the outcome differs", () => {
    const mixed = [
      event({ id: "2", classification: "healthy", state: "healthy" }),
      event({ id: "1", classification: "structural_break", state: "suspected" }),
    ];
    assert.equal(groupEvents(mixed).length, 2);
  });

  it("keeps entries apart when the evidence differs", () => {
    const mixed = [
      event({ id: "2", evidence: ["one reason"] }),
      event({ id: "1", evidence: ["a different reason"] }),
    ];
    assert.equal(groupEvents(mixed).length, 2);
  });

  it("reports a repeat count in the scrape history", () => {
    const html = renderScraperPage(
      { ...target, state: "manual_review", events: [event({ id: "2" }), event({ id: "1" })] },
      "activity",
      status(),
    );
    assert.match(html, /2 runs, same outcome/);
  });

  it("handles an empty history", () => {
    assert.deepEqual(groupEvents([]), []);
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
