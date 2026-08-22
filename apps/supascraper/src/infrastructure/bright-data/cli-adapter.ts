import { spawn } from "node:child_process";

import type {
  CollectorFactory,
  CreatedCollector,
} from "../../application/add-target/add-target.js";
import type {
  CollectorApprover,
  CollectorHealer,
  HealEnvelope,
} from "../../application/heal-and-verify/heal-and-verify.js";
import type { CollectorRunner } from "../../application/run-collector/run-collector.js";
import type {
  CollectorConfig,
  NormalizedRunResult,
  SafeRunError,
} from "../../domain/contracts/collector-run.js";
import type { Logger } from "../logging/logger.js";
import { parseRunOutput, UnparseableRunOutputError } from "./parse-run-output.js";

const MAX_CAPTURED_BYTES = 4 * 1024 * 1024;
const MAX_HEAL_PROMPT_LENGTH = 1000;

/** How long Bright Data may poll its AI generation before giving up. */
const CREATE_POLL_TIMEOUT_MS = 15 * 60 * 1000;

/** Retries only cover the concurrent-job cap, so a small budget is enough. */
const CREATE_MAX_RETRIES = 2;

/** Outer bound covering polling plus any queued retry waits. */
const CREATE_PROCESS_TIMEOUT_MS = 25 * 60 * 1000;

/** Steps that prove the healed template was actually persisted. See D-015. */
const SAVE_STEP = "save_new_template";

export interface CliInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

export interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface CliRunner {
  invoke(invocation: CliInvocation): Promise<CliResult>;
}

/**
 * Executes the Bright Data CLI as a child process.
 *
 * Arguments are always passed as an array and never interpolated into a shell
 * string, so a heal prompt or URL cannot inject a command.
 */
export class ProcessCliRunner implements CliRunner {
  invoke(invocation: CliInvocation): Promise<CliResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(invocation.command, [...invocation.args], {
        shell: false,
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      let killTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        // Escalate if the child ignores the polite signal, so a wedged process
        // cannot make the timeout meaningless.
        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 5000);
        killTimer.unref();
      }, invocation.timeoutMs);

      const clearTimers = (): void => {
        clearTimeout(timer);
        if (killTimer !== undefined) {
          clearTimeout(killTimer);
        }
      };

      const append = (current: string, chunk: Buffer): string =>
        current.length >= MAX_CAPTURED_BYTES
          ? current
          : current + chunk.toString("utf8");

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });

      child.once("error", (error) => {
        clearTimers();
        reject(error);
      });

      child.once("close", (code) => {
        clearTimers();
        resolve({ code, stdout, stderr, timedOut });
      });
    });
  }
}

export interface BrightDataCliOptions {
  /** Executable to run, defaulting to the current Node binary. */
  readonly command?: string;
  /** Path to the pinned CLI entry point. */
  readonly cliEntryPoint?: string;
}

/**
 * Strips terminal noise so a stored or displayed error stays readable and does
 * not carry spinner frames or ANSI escapes.
 */
export function sanitizeCliText(value: string, maxLength = 600): string {
  const cleaned = value
    // ANSI escape sequences, then Braille-range spinner frames the CLI emits.
    .replace(/\u001B\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[\u2800-\u28FF]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" | ");

  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned;
}

function toSafeError(result: CliResult): SafeRunError {
  if (result.timedOut) {
    return {
      category: "timeout",
      message: "The collector run exceeded its timeout.",
      retryable: true,
    };
  }

  const detail = sanitizeCliText(result.stderr || result.stdout);
  const lowered = detail.toLowerCase();
  const retryable =
    lowered.includes("429") ||
    lowered.includes("rate limit") ||
    lowered.includes("timeout") ||
    lowered.includes("socket") ||
    lowered.includes("econn") ||
    lowered.includes("temporarily");

  return {
    category: retryable ? "transient" : "command_failure",
    message: detail.length > 0 ? detail : "The collector command failed.",
    retryable,
  };
}

function readEnvelope(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export class BrightDataApprovalNotSavedError extends Error {
  constructor(steps: readonly string[]) {
    super(
      `Approval did not persist the healed template. Expected "${SAVE_STEP}" in completed steps but received: ${steps.join(", ") || "none"}.`,
    );
    this.name = "BrightDataApprovalNotSavedError";
  }
}

/**
 * Bright Data integration over the pinned CLI.
 *
 * Success is judged from parsed output rather than from the exit code, because
 * the CLI writes progress to stderr and a merged-stream invocation can report a
 * non-zero code on an otherwise successful command.
 */
export class BrightDataCliAdapter
  implements CollectorRunner, CollectorHealer, CollectorApprover, CollectorFactory
{
  readonly #cli: CliRunner;
  readonly #logger: Logger;
  readonly #command: string;
  readonly #entryPoint: string;

  constructor(cli: CliRunner, logger: Logger, options: BrightDataCliOptions = {}) {
    this.#cli = cli;
    this.#logger = logger;
    this.#command = options.command ?? process.execPath;
    this.#entryPoint =
      options.cliEntryPoint ?? "node_modules/@brightdata/cli/dist/index.js";
  }

  #args(rest: readonly string[]): string[] {
    return [this.#entryPoint, ...rest];
  }

  async run(config: CollectorConfig): Promise<NormalizedRunResult> {
    const startedAt = new Date().toISOString();
    const base = {
      collectorId: config.collectorId,
      targetUrl: config.targetUrl,
      startedAt,
      snapshotId: null,
    };

    let result: CliResult;
    try {
      result = await this.#cli.invoke({
        command: this.#command,
        args: this.#args([
          "scraper",
          "run",
          config.collectorId,
          config.targetUrl,
          "--json",
        ]),
        timeoutMs: config.timeoutMs,
      });
    } catch (error) {
      this.#logger.error("Collector run could not be started.", {
        collectorId: config.collectorId,
      });
      return {
        ...base,
        finishedAt: new Date().toISOString(),
        status: "failed",
        records: [],
        extractionErrors: [],
        safeError: {
          category: "spawn_failure",
          message:
            error instanceof Error
              ? sanitizeCliText(error.message)
              : "The collector command could not be started.",
          retryable: false,
        },
      };
    }

    const finishedAt = new Date().toISOString();

    if (result.timedOut) {
      return {
        ...base,
        finishedAt,
        status: "timed_out",
        records: [],
        extractionErrors: [],
        safeError: toSafeError(result),
      };
    }

    try {
      const parsed = parseRunOutput(result.stdout);
      return {
        ...base,
        finishedAt,
        status: "succeeded",
        records: parsed.records,
        extractionErrors: parsed.extractionErrors,
        safeError: null,
      };
    } catch (error) {
      // Unparseable output is a failure, never an empty success. Treating it as
      // an empty dataset would later be misread as a structural break.
      if (error instanceof UnparseableRunOutputError) {
        return {
          ...base,
          finishedAt,
          status: "failed",
          records: [],
          extractionErrors: [],
          safeError: toSafeError(result),
        };
      }
      throw error;
    }
  }

  /**
   * Builds a new scraper from a plain-language description.
   *
   * Bright Data's AI generation runs for several minutes and can be queued
   * behind a concurrency cap, so the retry budget is bounded explicitly rather
   * than left at the CLI default. Without a bound, one queued request could hold
   * a child process open far longer than the caller expects.
   */
  async create(input: {
    readonly url: string;
    readonly description: string;
    readonly name: string;
  }): Promise<CreatedCollector> {
    const result = await this.#cli.invoke({
      command: this.#command,
      args: this.#args([
        "scraper",
        "create",
        input.url,
        input.description,
        "--name",
        input.name,
        "--timeout",
        String(Math.round(CREATE_POLL_TIMEOUT_MS / 1000)),
        "--max-retries",
        String(CREATE_MAX_RETRIES),
        "--json",
      ]),
      timeoutMs: CREATE_PROCESS_TIMEOUT_MS,
    });

    if (result.timedOut) {
      throw new Error(
        "Building the scraper took longer than the allowed time. Bright Data may still be working; try again in a few minutes.",
      );
    }

    const envelope = readEnvelope(result.stdout);
    const collectorId = envelope?.["collector_id"];

    // The collector id is the only part of the envelope that matters, and it is
    // what proves the scraper exists. A missing id is a failure regardless of
    // what the reported status says.
    if (typeof collectorId !== "string" || !collectorId.startsWith("c_")) {
      throw new Error(
        `Bright Data did not return a scraper for that page: ${
          sanitizeCliText(result.stderr || result.stdout, 300) ||
          "no collector id was reported."
        }`,
      );
    }

    this.#logger.info("Built a new collector.", { collectorId });
    return { collectorId };
  }

  async heal(collectorId: string, prompt: string): Promise<HealEnvelope> {
    const trimmed = prompt.trim();
    if (trimmed.length === 0) {
      throw new Error("A heal prompt is required.");
    }
    if (trimmed.length > MAX_HEAL_PROMPT_LENGTH) {
      throw new Error(
        `A heal prompt must be at most ${String(MAX_HEAL_PROMPT_LENGTH)} characters.`,
      );
    }

    // --auto-approve is deliberately omitted so the run stops at the approval
    // gate and the preview can be reviewed before anything is committed.
    const result = await this.#cli.invoke({
      command: this.#command,
      args: this.#args(["scraper", "heal", collectorId, trimmed, "--json"]),
      timeoutMs: 15 * 60 * 1000,
    });

    const envelope = readEnvelope(result.stdout);
    if (!envelope) {
      throw new Error(
        `Heal produced no readable envelope: ${sanitizeCliText(result.stderr || result.stdout)}`,
      );
    }

    return {
      status: typeof envelope["status"] === "string" ? envelope["status"] : "unknown",
      completedSteps: Array.isArray(envelope["completed_steps"])
        ? envelope["completed_steps"].filter(
            (step): step is string => typeof step === "string",
          )
        : [],
      previewResult: envelope["preview_result"] ?? null,
      diffSummary:
        typeof envelope["diff_summary"] === "string" ? envelope["diff_summary"] : null,
      safeMessage:
        typeof envelope["next_step"] === "string" ? envelope["next_step"] : "",
    };
  }

  async approve(collectorId: string): Promise<void> {
    await this.#resume(collectorId, ["--auto-save"]);
  }

  async reject(collectorId: string): Promise<void> {
    await this.#resume(collectorId, ["--reject"], false);
  }

  async #resume(
    collectorId: string,
    flags: readonly string[],
    requireSave = true,
  ): Promise<void> {
    const result = await this.#cli.invoke({
      command: this.#command,
      args: this.#args(["scraper", "approve", collectorId, ...flags, "--json"]),
      timeoutMs: 15 * 60 * 1000,
    });

    const envelope = readEnvelope(result.stdout);
    const steps = Array.isArray(envelope?.["completed_steps"])
      ? envelope["completed_steps"].filter(
          (step): step is string => typeof step === "string",
        )
      : [];

    if (!requireSave) {
      return;
    }

    // Verified live: approving without --auto-save ends at user_approval and
    // silently leaves the collector unrepaired. Absence of the save step is a
    // failure, not a success.
    if (!steps.includes(SAVE_STEP)) {
      throw new BrightDataApprovalNotSavedError(steps);
    }
  }
}
