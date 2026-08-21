import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  createTargetServer,
  describeClient,
  normalizePath,
  resolvePort,
} from "../dist/server.js";
import { FileScenarioStore } from "../dist/state/file-scenario-store.js";
import { InMemoryScenarioStore } from "../dist/state/scenario-store.js";
import { RequestLog } from "../dist/state/request-log.js";
import { handleScenarioControl } from "../dist/routes/control-route.js";
import { buildCatalogResponse, buildProductResponse } from "../dist/routes/catalog-route.js";

const TOKEN = "test-token-value";

describe("normalizePath", () => {
  it("treats trailing and duplicate slashes as equivalent", () => {
    assert.equal(normalizePath("/catalog"), "/catalog");
    assert.equal(normalizePath("/catalog/"), "/catalog");
    assert.equal(normalizePath("/catalog//"), "/catalog");
    assert.equal(normalizePath("//catalog"), "/catalog");
  });

  it("preserves the root", () => {
    assert.equal(normalizePath("/"), "/");
    assert.equal(normalizePath("//"), "/");
  });
});

describe("resolvePort", () => {
  it("prefers the platform-injected PORT", () => {
    assert.equal(resolvePort({ PORT: "8080", TARGET_SITE_PORT: "3005" }), 8080);
  });

  it("falls back to TARGET_SITE_PORT then the default", () => {
    assert.equal(resolvePort({ TARGET_SITE_PORT: "3005" }), 3005);
    assert.equal(resolvePort({}), 3001);
    assert.equal(resolvePort({ PORT: "" }), 3001);
  });

  it("rejects values outside the valid port range", () => {
    for (const bad of ["0", "70000", "-1", "abc", "1.5.5"]) {
      assert.throws(() => resolvePort({ PORT: bad }), /between 1 and 65535/);
    }
  });
});

describe("describeClient", () => {
  it("never retains an IP address", () => {
    const result = describeClient("203.0.113.7, 198.51.100.2");
    assert.equal(result, "proxied (2 hops)");
    assert.ok(!result.includes("203.0.113.7"));
  });

  it("handles absent, empty, and array header forms", () => {
    assert.equal(describeClient(undefined), "direct");
    assert.equal(describeClient(""), "direct");
    assert.equal(describeClient(["203.0.113.7"]), "proxied (1 hop)");
  });
});

describe("RequestLog", () => {
  it("keeps newest first and never exceeds its limit", () => {
    const log = new RequestLog(3);
    for (let index = 0; index < 5; index += 1) {
      log.record({
        at: new Date(index).toISOString(),
        method: "GET",
        url: `/p/${String(index)}`,
        status: 200,
        userAgent: "-",
        client: "direct",
      });
    }
    const entries = log.list();
    assert.equal(entries.length, 3);
    assert.equal(entries[0]?.url, "/p/4");
    assert.equal(entries[2]?.url, "/p/2");
  });

  it("returns a copy so callers cannot mutate internal state", () => {
    const log = new RequestLog();
    log.record({
      at: "now",
      method: "GET",
      url: "/a",
      status: 200,
      userAgent: "-",
      client: "direct",
    });
    (log.list() as unknown[]).push({});
    assert.equal(log.list().length, 1);
  });
});

describe("FileScenarioStore", () => {
  let directory: string;

  before(() => {
    directory = mkdtempSync(join(tmpdir(), "supascraper-store-"));
  });

  after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("defaults to baseline when no file exists", () => {
    const store = new FileScenarioStore(join(directory, "missing.json"));
    assert.equal(store.get(), "baseline");
  });

  it("persists a mode and reloads it in a fresh instance", () => {
    const path = join(directory, "persist.json");
    new FileScenarioStore(path).set("structural_break");
    assert.equal(new FileScenarioStore(path).get(), "structural_break");
  });

  it("falls back to baseline on corrupt state rather than throwing", () => {
    const path = join(directory, "corrupt.json");
    writeFileSync(path, "{ not json", "utf8");
    assert.equal(new FileScenarioStore(path).get(), "baseline");
  });

  it("rejects an unrecognized persisted mode", () => {
    const path = join(directory, "bogus.json");
    writeFileSync(path, JSON.stringify({ mode: "chaos" }), "utf8");
    assert.equal(new FileScenarioStore(path).get(), "baseline");
  });

  it("leaves no temporary file behind after a write", () => {
    const path = join(directory, "clean.json");
    const store = new FileScenarioStore(path);
    store.set("legitimate_change");
    assert.throws(() => readFileSync(`${path}.tmp`, "utf8"));
    assert.equal(store.get(), "legitimate_change");
  });

  it("reset returns to baseline", () => {
    const path = join(directory, "reset.json");
    const store = new FileScenarioStore(path);
    store.set("transient_error");
    store.reset();
    assert.equal(store.get(), "baseline");
    assert.equal(new FileScenarioStore(path).get(), "baseline");
  });
});

describe("handleScenarioControl", () => {
  it("refuses to operate when no token is configured", () => {
    const store = new InMemoryScenarioStore();
    const result = handleScenarioControl({ mode: "structural_break" }, `Bearer ${TOKEN}`, undefined, store);
    assert.equal(result.statusCode, 503);
    assert.equal(store.get(), "baseline");
  });

  it("rejects missing, wrong, and malformed authorization without changing state", () => {
    const store = new InMemoryScenarioStore();
    const attempts = [undefined, "Bearer wrong", "NotBearer " + TOKEN, "", TOKEN];
    for (const header of attempts) {
      const result = handleScenarioControl({ mode: "structural_break" }, header, TOKEN, store);
      assert.equal(result.statusCode, 401, `header: ${String(header)}`);
    }
    assert.equal(store.get(), "baseline");
  });

  it("rejects unknown modes and malformed bodies without changing state", () => {
    const store = new InMemoryScenarioStore();
    store.set("legitimate_change");
    for (const body of [{ mode: "chaos" }, {}, null, "string", 42, { mode: 1 }, []]) {
      const result = handleScenarioControl(body, `Bearer ${TOKEN}`, TOKEN, store);
      assert.equal(result.statusCode, 400);
    }
    assert.equal(store.get(), "legitimate_change");
  });

  it("accepts every valid mode and reset", () => {
    const store = new InMemoryScenarioStore();
    for (const mode of ["legitimate_change", "structural_break", "transient_error", "baseline"]) {
      const result = handleScenarioControl({ mode }, `Bearer ${TOKEN}`, TOKEN, store);
      assert.equal(result.statusCode, 200);
      assert.equal(store.get(), mode);
    }
    const reset = handleScenarioControl({ mode: "reset" }, `Bearer ${TOKEN}`, TOKEN, store);
    assert.equal(reset.statusCode, 200);
    assert.equal(store.get(), "baseline");
  });

  it("never echoes the token in a response body", () => {
    const store = new InMemoryScenarioStore();
    for (const header of [undefined, `Bearer ${TOKEN}`]) {
      const result = handleScenarioControl({ mode: "baseline" }, header, TOKEN, store);
      assert.ok(!result.body.includes(TOKEN));
    }
  });
});

describe("catalog and product rendering", () => {
  it("escapes markup characters so values cannot alter page structure", () => {
    const response = buildProductResponse("baseline", "MTR-100");
    assert.equal(response.statusCode, 200);
    assert.ok(!response.body.includes("<script"));
  });

  it("serves a 503 for every page in transient_error", () => {
    assert.equal(buildCatalogResponse("transient_error").statusCode, 503);
    assert.equal(buildProductResponse("transient_error", "MTR-100").statusCode, 503);
  });

  it("returns 404 for an unknown sku", () => {
    assert.equal(buildProductResponse("baseline", "NOPE-000").statusCode, 404);
  });

  it("sets no-store so a stale scenario cannot be served", () => {
    assert.match(buildCatalogResponse("baseline").headers["cache-control"] ?? "", /no-store/);
    assert.match(
      buildProductResponse("baseline", "MTR-100").headers["cache-control"] ?? "",
      /no-store/,
    );
  });

  it("structural_break replaces the baseline markup rather than adding to it", () => {
    const baseline = buildProductResponse("baseline", "MTR-100").body;
    const broken = buildProductResponse("structural_break", "MTR-100").body;

    assert.ok(baseline.includes("product-detail"));
    assert.ok(!broken.includes("product-detail"), "baseline marker must be absent");
    assert.ok(broken.includes("item-sheet"));
  });

  it("structural_break keeps the information visible to a human", () => {
    const broken = buildProductResponse("structural_break", "MTR-100").body;
    assert.ok(broken.includes("Precision Stepper Motor"));
    assert.ok(broken.includes("MTR-100"));
    assert.match(broken, /\$\d+\.\d{2}/);
  });

  it("legitimate_change keeps structure but moves values", () => {
    const baseline = buildProductResponse("baseline", "MTR-100").body;
    const changed = buildProductResponse("legitimate_change", "MTR-100").body;
    assert.ok(changed.includes("product-detail"));
    assert.notEqual(baseline, changed);
  });

  it("listing links to detail pages so the URL pattern is discoverable", () => {
    const listing = buildCatalogResponse("baseline").body;
    for (const sku of ["MTR-100", "SNS-240", "RLY-310"]) {
      assert.ok(listing.includes(`href="/product/${sku}"`), `missing link for ${sku}`);
    }
  });
});

describe("target server over HTTP", () => {
  let server: Server;
  let base: string;

  before(async () => {
    process.env["TARGET_CONTROL_TOKEN"] = TOKEN;
    server = createTargetServer(new InMemoryScenarioStore());
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
  });

  it("serves the catalog at the root, /catalog, and with a trailing slash", async () => {
    for (const path of ["/", "/catalog", "/catalog/"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
      assert.ok((await response.text()).includes("product-card"));
    }
  });

  it("does not hang on a malformed percent-escape", async () => {
    const response = await fetch(`${base}/product/%`);
    assert.equal(response.status, 400);
  });

  it("returns 404 for an unknown path", async () => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });

  it("rejects an oversized control body with 413", async () => {
    const response = await fetch(`${base}/__control/scenario`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ mode: "baseline", padding: "x".repeat(20 * 1024) }),
    });
    assert.equal(response.status, 413);
  });

  it("rejects an invalid JSON control body with 400", async () => {
    const response = await fetch(`${base}/__control/scenario`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: "{ not json",
    });
    assert.equal(response.status, 400);
  });

  it("requires the token for the diagnostic request log", async () => {
    assert.equal((await fetch(`${base}/__control/requests`)).status, 401);
    const authorized = await fetch(`${base}/__control/requests`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(authorized.status, 200);
  });

  it("records requests without retaining an IP address", async () => {
    await fetch(`${base}/catalog`, { headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.4" } });
    const response = await fetch(`${base}/__control/requests`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await response.json()) as { requests: { client: string }[] };
    assert.ok(body.requests.length > 0);
    assert.ok(!JSON.stringify(body).includes("203.0.113.9"));
    assert.ok(body.requests.some((entry) => entry.client.startsWith("proxied")));
  });

  it("does not expose the token through any endpoint", async () => {
    for (const path of ["/", "/catalog", "/health", "/nope"]) {
      const body = await (await fetch(base + path)).text();
      assert.ok(!body.includes(TOKEN), path);
    }
  });
});
