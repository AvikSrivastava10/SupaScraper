import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  parseTargetsFile,
  singleTarget,
  TargetConfigError,
} from "../dist/config/targets.js";
import { loadConfig } from "../dist/config/config.js";

const VALID = JSON.stringify({
  targets: [
    {
      id: "books",
      label: "Books",
      collectorId: "c_abc",
      targetUrl: "https://books.example/catalogue",
      fieldDescription: "name, sku, price, availability",
      controllable: false,
    },
    {
      id: "demo",
      label: "Demo",
      collectorId: "c_def",
      targetUrl: "https://demo.example/catalog",
      fieldDescription: "name, sku, price, availability",
      controllable: true,
    },
  ],
});

describe("parseTargetsFile", () => {
  it("reads several targets and applies the default timeout", () => {
    const targets = parseTargetsFile(VALID, 1234);
    assert.equal(targets.length, 2);
    assert.equal(targets[0]?.id, "books");
    assert.equal(targets[0]?.controllable, false);
    assert.equal(targets[1]?.controllable, true);
    assert.equal(targets[0]?.timeoutMs, 1234);
  });

  it("accepts a bare array as well as a wrapped object", () => {
    const bare = JSON.parse(VALID) as { targets: unknown[] };
    assert.equal(parseTargetsFile(JSON.stringify(bare.targets), 1).length, 2);
  });

  it("honours a per-target timeout override", () => {
    const withTimeout = JSON.parse(VALID) as { targets: Record<string, unknown>[] };
    withTimeout.targets[0]!["timeoutMs"] = 999;
    assert.equal(parseTargetsFile(JSON.stringify(withTimeout), 1)[0]?.timeoutMs, 999);
  });

  it("rejects malformed files rather than starting with half a config", () => {
    for (const contents of ["", "not json", "{}", '{"targets":"nope"}', "[1,2]"]) {
      assert.throws(() => parseTargetsFile(contents, 1), TargetConfigError, contents);
    }
  });

  it("requires every field a run depends on", () => {
    for (const missing of ["id", "label", "collectorId", "targetUrl", "fieldDescription"]) {
      const broken = JSON.parse(VALID) as { targets: Record<string, unknown>[] };
      delete broken.targets[0]![missing];
      assert.throws(() => parseTargetsFile(JSON.stringify(broken), 1), TargetConfigError, missing);
    }
  });

  it("rejects a collector id that is not a c_ identifier", () => {
    const broken = JSON.parse(VALID) as { targets: Record<string, unknown>[] };
    broken.targets[0]!["collectorId"] = "x_nope";
    assert.throws(() => parseTargetsFile(JSON.stringify(broken), 1), /must start with c_/);
  });

  it("rejects a non-HTTPS target unless it is localhost", () => {
    const broken = JSON.parse(VALID) as { targets: Record<string, unknown>[] };
    broken.targets[0]!["targetUrl"] = "http://insecure.example/catalog";
    assert.throws(() => parseTargetsFile(JSON.stringify(broken), 1), /HTTPS/);

    const local = JSON.parse(VALID) as { targets: Record<string, unknown>[] };
    local.targets[0]!["targetUrl"] = "http://localhost:3001/catalog";
    assert.equal(parseTargetsFile(JSON.stringify(local), 1).length, 2);
  });

  it("rejects duplicate ids, which would collide in storage and URLs", () => {
    const broken = JSON.parse(VALID) as { targets: Record<string, unknown>[] };
    broken.targets[1]!["id"] = "books";
    assert.throws(() => parseTargetsFile(JSON.stringify(broken), 1), /Duplicate target id/);
  });
});

describe("singleTarget", () => {
  it("wraps one env-configured collector so old setups keep working", () => {
    const target = singleTarget({
      collectorId: "c_abc",
      targetUrl: "https://example.test/catalog",
      fieldDescription: "fields",
      timeoutMs: 5,
    });
    assert.equal(target.id, "primary");
    assert.equal(target.controllable, false);
  });
});

describe("loadConfig with targets", () => {
  it("falls back to the single collector when no file is given", () => {
    const config = loadConfig({
      SUPASCRAPER_COLLECTOR_ID: "c_abc",
      SUPASCRAPER_TARGET_URL: "https://example.test/catalog",
    });
    assert.equal(config.targets.length, 1);
    assert.equal(config.targets[0]?.id, "primary");
  });

  it("reports no targets when nothing is configured", () => {
    assert.equal(loadConfig({}).targets.length, 0);
  });
});

describe("the committed targets file", () => {
  const read = (name: string): string =>
    readFileSync(new URL(`../../../${name}`, import.meta.url), "utf8");

  it("preloads nothing, so the dashboard starts clean", () => {
    // Sites are meant to be added through the dashboard, where the whole
    // sequence is visible. Preloaded examples buried that under other people's
    // data and were never asked for.
    assert.deepEqual(parseTargetsFile(read("targets.json"), 420_000), []);
  });

  it("keeps a demo pair available for a break that can be caused on cue", () => {
    // A live break has to be reproducible, and no third-party site will
    // restructure its markup on request, so the controlled target cannot simply
    // be deleted. It is opt-in rather than preloaded.
    const targets = parseTargetsFile(read("targets.demo.json"), 420_000);

    assert.ok(targets.length >= 2, "expected at least two targets");
    assert.ok(
      targets.some((target) => target.controllable),
      "a controllable site is needed to demo a break",
    );
    assert.ok(
      targets.some((target) => !target.controllable),
      "a site we do not control proves the pipeline works on the open web",
    );

    for (const target of targets) {
      assert.match(target.collectorId, /^c_/);
      assert.equal(new URL(target.targetUrl).protocol, "https:");
    }
  });
});
