import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { FileTargetRegistry } from "../dist/infrastructure/persistence/target-store.js";
import {
  deriveTargetId,
  SiteInputError,
  validateSite,
} from "../dist/application/add-target/validate-site.js";
import { addTarget } from "../dist/application/add-target/add-target.js";
import type { TargetConfig } from "../dist/config/targets.js";
import type { PendingTarget } from "../dist/application/add-target/target-registry.js";

const SILENT = { info: () => undefined, error: () => undefined };

const SEED: TargetConfig = {
  id: "controlled",
  label: "Controlled demo site",
  collectorId: "c_seed",
  targetUrl: "https://demo.test/catalog",
  fieldDescription: "name, sku, price, availability",
  controllable: true,
  timeoutMs: 5000,
};

const pending = (overrides: Partial<PendingTarget> = {}): PendingTarget => ({
  id: "example-com",
  label: "example.com",
  targetUrl: "https://example.com/products",
  fieldDescription: "Extract the title and price of each product.",
  requestedAt: "2026-08-22T00:00:00Z",
  status: "building",
  message: "building",
  ...overrides,
});

describe("FileTargetRegistry", () => {
  let directory: string;
  let counter = 0;

  const store = (seeds: readonly TargetConfig[] = [SEED]): FileTargetRegistry => {
    counter += 1;
    return new FileTargetRegistry(seeds, join(directory, `t-${String(counter)}.json`), 5000);
  };

  const reopen = (registry: FileTargetRegistry, seeds: readonly TargetConfig[] = [SEED]) =>
    new FileTargetRegistry(seeds, registry.filePath, 5000);

  before(() => {
    directory = mkdtempSync(join(tmpdir(), "supascraper-targets-"));
  });

  after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("lists the committed seeds before anything is added", () => {
    const registry = store();
    assert.deepEqual(
      registry.list().map((target) => target.id),
      ["controlled"],
    );
    assert.deepEqual(registry.pending(), []);
  });

  it("registers a pending site and keeps it across a restart", () => {
    const registry = store();
    registry.addPending(pending());

    const restarted = reopen(registry);
    assert.equal(restarted.pending().length, 1);
    assert.equal(restarted.pending()[0]?.id, "example-com");
    assert.equal(restarted.list().length, 1, "a pending site is not yet a target");
  });

  it("promotes a pending site once its collector exists", () => {
    const registry = store();
    registry.addPending(pending());
    const target = registry.resolvePending("example-com", "c_new", 9000);

    assert.equal(target.collectorId, "c_new");
    assert.equal(target.timeoutMs, 9000);
    assert.equal(target.controllable, false, "a user site can never be broken on demand");
    assert.deepEqual(registry.pending(), []);
    assert.deepEqual(
      registry.list().map((entry) => entry.id),
      ["controlled", "example-com"],
    );

    const restarted = reopen(registry);
    assert.equal(restarted.get("example-com")?.collectorId, "c_new");
  });

  it("refuses to promote a site it was never asked to build", () => {
    const registry = store();
    assert.throws(() => registry.resolvePending("ghost", "c_x", 1000), /No pending target/);
  });

  it("records a build failure against the site rather than dropping it", () => {
    const registry = store();
    registry.addPending(pending());
    registry.failPending("example-com", "AI generation failed");

    const entry = reopen(registry).pending()[0];
    assert.equal(entry?.status, "failed");
    assert.equal(entry?.message, "AI generation failed");
  });

  it("treats seeds, added sites, and pending sites as taken names", () => {
    const registry = store();
    registry.addPending(pending());

    assert.equal(registry.isTaken("controlled"), true, "seed");
    assert.equal(registry.isTaken("example-com"), true, "pending");
    assert.equal(registry.isTaken("free"), false);

    registry.resolvePending("example-com", "c_new", 5000);
    assert.equal(registry.isTaken("example-com"), true, "added");
  });

  it("recognizes the same page despite a trailing slash or different case", () => {
    const registry = store();
    registry.addPending(pending());

    for (const url of [
      "https://example.com/products",
      "https://example.com/products/",
      "https://EXAMPLE.com/products",
    ]) {
      assert.equal(registry.hasUrl(url), true, url);
    }
    assert.equal(registry.hasUrl("https://example.com/other"), false);
  });

  it("lets a failed site be attempted again", () => {
    const registry = store();
    registry.addPending(pending());
    registry.failPending("example-com", "AI generation failed");
    assert.equal(
      registry.hasUrl("https://example.com/products"),
      false,
      "a failed attempt must not block a retry",
    );
  });

  it("starts from the seeds when the store file is unreadable", () => {
    const path = join(directory, "corrupt.json");
    writeFileSync(path, "{{{", "utf8");
    const registry = new FileTargetRegistry([SEED], path, 5000);
    assert.deepEqual(
      registry.list().map((target) => target.id),
      ["controlled"],
    );
    assert.deepEqual(registry.pending(), []);
  });

  it("drops a stored target that is not valid instead of starting with half a config", () => {
    const path = join(directory, "invalid.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        targets: [{ id: "bad", label: "Bad", collectorId: "nope", targetUrl: "https://x.test", fieldDescription: "d" }],
        pending: [],
      }),
      "utf8",
    );
    const registry = new FileTargetRegistry([SEED], path, 5000);
    assert.equal(registry.get("bad"), null, "a collector id must start with c_");
  });

  it("discards a malformed pending entry", () => {
    const path = join(directory, "bad-pending.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        targets: [],
        pending: [null, 5, { id: "x" }, { ...pending(), status: "who-knows" }],
      }),
      "utf8",
    );
    assert.deepEqual(new FileTargetRegistry([], path, 5000).pending(), []);
  });

  it("never lets a stored target shadow a committed seed", () => {
    const path = join(directory, "shadow.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        targets: [{ ...SEED, collectorId: "c_hijack", controllable: false }],
        pending: [],
      }),
      "utf8",
    );
    const registry = new FileTargetRegistry([SEED], path, 5000);
    assert.equal(registry.get("controlled")?.collectorId, "c_seed");
    assert.equal(registry.list().length, 1);
  });

  it("writes only the added sites, never the committed seeds", () => {
    const registry = store();
    registry.addPending(pending());
    registry.resolvePending("example-com", "c_new", 5000);

    const written = JSON.parse(readFileSync(registry.filePath, "utf8")) as {
      targets: { id: string }[];
    };
    assert.deepEqual(
      written.targets.map((target) => target.id),
      ["example-com"],
    );
  });
});

describe("validateSite", () => {
  const free = () => false;

  it("normalizes the description and derives a label from the host", () => {
    const site = validateSite(
      {
        url: "https://www.example.com/shop?page=2",
        description: "  Extract   the title\nand the price  ",
      },
      free,
    );
    assert.equal(site.description, "Extract the title and the price");
    assert.equal(site.label, "example.com");
    assert.equal(site.id, "example-com-shop");
  });

  it("keeps a supplied label and trims it", () => {
    const site = validateSite(
      {
        url: "https://example.com/shop",
        description: "Extract the title and the price of each item.",
        label: "  My shop  ",
      },
      free,
    );
    assert.equal(site.label, "My shop");
  });

  it("rejects a label longer than the field allows", () => {
    assert.throws(
      () =>
        validateSite(
          {
            url: "https://example.com/shop",
            description: "Extract the title and the price of each item.",
            label: "x".repeat(61),
          },
          free,
        ),
      SiteInputError,
    );
  });

  it("rejects a URL long enough to be a payload rather than an address", () => {
    assert.throws(
      () =>
        validateSite(
          {
            url: `https://example.com/${"a".repeat(2100)}`,
            description: "Extract the title and the price of each item.",
          },
          free,
        ),
      /at most 2000/,
    );
  });

  it("rejects a scheme that is not the web", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/x",
      "javascript:alert(1)",
      "data:text/html,<h1>x</h1>",
    ]) {
      assert.throws(
        () => validateSite({ url, description: "Extract the title and price." }, free),
        SiteInputError,
        url,
      );
    }
  });

  it("requires a full public hostname", () => {
    assert.throws(
      () => validateSite({ url: "https://intranet/x", description: "Extract title and price." }, free),
      /full public hostname/,
    );
  });
});

describe("deriveTargetId", () => {
  it("produces a readable, URL-safe identifier", () => {
    assert.equal(
      deriveTargetId(new URL("https://books.toscrape.com/travel_2"), () => false),
      "books-toscrape-com-travel-2",
    );
  });

  it("truncates a long path without leaving a trailing separator", () => {
    const id = deriveTargetId(
      new URL("https://books.toscrape.com/catalogue/category/books/travel_2/index.html"),
      () => false,
    );
    assert.ok(id.length <= 40, id);
    assert.doesNotMatch(id, /^-|-$/, id);
    assert.match(id, /^[a-z0-9-]+$/);
  });

  it("suffixes rather than colliding when the name is taken", () => {
    const taken = new Set(["example-com-shop", "example-com-shop-2"]);
    assert.equal(
      deriveTargetId(new URL("https://example.com/shop"), (id) => taken.has(id)),
      "example-com-shop-3",
    );
  });

  it("still produces something usable for a bare root URL", () => {
    assert.equal(deriveTargetId(new URL("https://example.com/"), () => false), "example-com");
  });
});

describe("addTarget", () => {
  let directory: string;
  let counter = 0;

  const registry = (): FileTargetRegistry => {
    counter += 1;
    return new FileTargetRegistry([], join(directory, `a-${String(counter)}.json`), 5000);
  };

  before(() => {
    directory = mkdtempSync(join(tmpdir(), "supascraper-add-target-"));
  });

  after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("returns before the scraper exists and reports the site as building", async () => {
    const target = registry();
    let released: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });

    const result = addTarget(
      {
        url: "https://example.com/products",
        description: "Extract the title and the price of each product card.",
      },
      {
        registry: target,
        factory: {
          create: async () => {
            await gate;
            return { collectorId: "c_new" };
          },
        },
        logger: SILENT,
        timeoutMs: 5000,
      },
    );

    assert.equal(result.pending.status, "building");
    assert.equal(target.pending().length, 1);
    assert.equal(target.list().length, 0, "nothing is monitored until the scraper exists");

    released?.();
    await result.completion;
    assert.equal(target.list().length, 1);
  });

  it("collects as soon as the scraper is ready, so a contract can be learned", async () => {
    const target = registry();
    const collected: string[] = [];

    const result = addTarget(
      {
        url: "https://example.com/products",
        description: "Extract the title and the price of each product card.",
      },
      {
        registry: target,
        factory: { create: () => Promise.resolve({ collectorId: "c_new" }) },
        logger: SILENT,
        timeoutMs: 5000,
        onReady: (ready) => {
          collected.push(ready.collectorId);
        },
      },
    );

    await result.completion;
    assert.deepEqual(collected, ["c_new"]);
  });

  it("never rejects, so a build failure cannot take the process down", async () => {
    const target = registry();
    const result = addTarget(
      {
        url: "https://example.com/products",
        description: "Extract the title and the price of each product card.",
      },
      {
        registry: target,
        factory: { create: () => Promise.reject(new Error("AI generation failed")) },
        logger: SILENT,
        timeoutMs: 5000,
      },
    );

    await result.completion;
    assert.equal(target.pending()[0]?.status, "failed");
    assert.equal(target.pending()[0]?.message, "AI generation failed");
    assert.equal(target.list().length, 0);
  });

  it("refuses a page that is already registered", () => {
    const target = registry();
    const deps = {
      registry: target,
      factory: { create: () => Promise.resolve({ collectorId: "c_new" }) },
      logger: SILENT,
      timeoutMs: 5000,
    };
    const input = {
      url: "https://example.com/products",
      description: "Extract the title and the price of each product card.",
    };

    addTarget(input, deps);
    assert.throws(() => addTarget(input, deps), /already being monitored/);
  });

  it("refuses invalid input before registering anything", () => {
    const target = registry();
    assert.throws(
      () =>
        addTarget(
          { url: "https://10.0.0.1/x", description: "Extract the title and price." },
          {
            registry: target,
            factory: { create: () => Promise.reject(new Error("must not be called")) },
            logger: SILENT,
            timeoutMs: 5000,
          },
        ),
      SiteInputError,
    );
    assert.deepEqual(target.pending(), []);
  });
});
