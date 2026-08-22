import type { TargetConfig } from "../../config/targets.js";
import {
  safeReporter,
  NO_PROGRESS,
  type ProgressReporter,
} from "../../domain/progress/pipeline-step.js";
import type { Logger } from "../../infrastructure/logging/logger.js";
import type { PendingTarget, TargetRegistry } from "./target-registry.js";
import { SiteInputError, validateSite, type SiteInput } from "./validate-site.js";

export interface CreatedCollector {
  readonly collectorId: string;
}

/** Builds a new scraper from a natural-language description. */
export interface CollectorFactory {
  create(input: {
    readonly url: string;
    readonly description: string;
    readonly name: string;
  }): Promise<CreatedCollector>;
}

export interface AddTargetDependencies {
  readonly registry: TargetRegistry;
  readonly factory: CollectorFactory;
  readonly logger: Logger;
  /** Run timeout applied to the target once its collector exists. */
  readonly timeoutMs: number;
  /** Called once the scraper is ready, so the caller can collect immediately. */
  readonly onReady?: (target: TargetConfig) => void;
  /**
   * Narrates provisioning. Bound to the derived target id, which is why it is a
   * factory rather than a plain reporter: the id is not known until validation
   * has run.
   */
  readonly progressFor?: (targetId: string) => ProgressReporter;
}

export interface AddTargetResult {
  readonly pending: PendingTarget;
  /**
   * Settles when provisioning finishes. Never rejects: a failure is recorded on
   * the pending entry so the dashboard can show it.
   */
  readonly completion: Promise<void>;
}

/**
 * Registers a user-supplied website and builds a scraper for it.
 *
 * Building takes minutes, so the site is registered as pending and the work
 * continues in the background. The caller gets an immediate answer and the
 * dashboard shows progress, rather than an HTTP request hanging for ten minutes.
 */
export function addTarget(
  input: SiteInput,
  dependencies: AddTargetDependencies,
): AddTargetResult {
  const { registry, factory, logger, timeoutMs, onReady, progressFor } = dependencies;

  const site = validateSite(input, (id) => registry.isTaken(id));

  if (registry.hasUrl(site.url)) {
    throw new SiteInputError("That page is already being monitored.");
  }

  const report = safeReporter(progressFor?.(site.id) ?? NO_PROGRESS);

  report({
    stage: "validate",
    status: "done",
    detail: `${site.url} accepted as a public page. Extracting: ${site.description}`,
  });

  const pending: PendingTarget = {
    id: site.id,
    label: site.label,
    targetUrl: site.url,
    fieldDescription: site.description,
    requestedAt: new Date().toISOString(),
    status: "building",
    message: "Bright Data is building a scraper for this page.",
  };
  registry.addPending(pending);

  logger.info("Building a scraper for a newly added site.", {
    target: site.id,
    url: site.url,
  });

  report({
    stage: "build_scraper",
    status: "started",
    detail: "Bright Data's AI is writing a scraper from that description. Usually 5 to 10 minutes.",
  });

  const completion = (async () => {
    try {
      const created = await factory.create({
        url: site.url,
        description: site.description,
        name: `supascraper-${site.id}`.slice(0, 60),
      });

      const target = registry.resolvePending(site.id, created.collectorId, timeoutMs);
      report({
        stage: "build_scraper",
        status: "done",
        detail: `Scraper built as collector ${created.collectorId}. Every later repair reuses this same id.`,
      });
      logger.info("Scraper is ready.", {
        target: target.id,
        collectorId: target.collectorId,
      });
      onReady?.(target);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "The scraper could not be built for this page.";
      registry.failPending(site.id, message);
      report({ stage: "build_scraper", status: "failed", detail: message });
      logger.error("Could not build a scraper for the added site.", {
        target: site.id,
        reason: message,
      });
    }
  })();

  return { pending, completion };
}

export { SiteInputError } from "./validate-site.js";
export type { SiteInput } from "./validate-site.js";
