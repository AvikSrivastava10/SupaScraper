import { timingSafeEqual } from "node:crypto";

import { isScenarioControlAction } from "@supascraper/shared";

import type { ScenarioStore } from "../state/scenario-store.js";
import type { HttpResponse } from "./http-response.js";
import { jsonResponse } from "./http-response.js";

function tokenMatches(authorizationHeader: string | undefined, token: string): boolean {
  if (
    authorizationHeader === undefined ||
    !authorizationHeader.startsWith("Bearer ")
  ) {
    return false;
  }

  const supplied = Buffer.from(authorizationHeader.slice("Bearer ".length));
  const expected = Buffer.from(token);

  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function readMode(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("mode" in value)) {
    return undefined;
  }

  return (value as { readonly mode?: unknown }).mode;
}

export function handleScenarioControl(
  body: unknown,
  authorizationHeader: string | undefined,
  configuredToken: string | undefined,
  store: ScenarioStore,
): HttpResponse {
  if (!configuredToken) {
    return jsonResponse(503, { error: "Scenario control is not configured." });
  }

  if (!tokenMatches(authorizationHeader, configuredToken)) {
    return jsonResponse(401, { error: "Unauthorized." });
  }

  const requestedMode = readMode(body);
  if (!isScenarioControlAction(requestedMode)) {
    return jsonResponse(400, { error: "Unknown scenario mode." });
  }

  if (requestedMode === "reset") {
    store.reset();
  } else {
    store.set(requestedMode);
  }

  return jsonResponse(200, { mode: store.get() });
}
