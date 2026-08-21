export interface Logger {
  info(message: string, details?: Readonly<Record<string, unknown>>): void;
  error(message: string, details?: Readonly<Record<string, unknown>>): void;
}

/**
 * Serializes a log line without letting a circular reference or a BigInt take
 * the process down. Logging must never be the thing that breaks a run.
 */
export function formatLogLine(
  level: "info" | "error",
  message: string,
  details: Readonly<Record<string, unknown>>,
): string {
  try {
    return JSON.stringify({ level, message, ...details });
  } catch {
    return JSON.stringify({
      level,
      message,
      detailsError: "details were not serializable",
    });
  }
}

export class ConsoleLogger implements Logger {
  info(message: string, details: Readonly<Record<string, unknown>> = {}): void {
    console.info(formatLogLine("info", message, details));
  }

  error(message: string, details: Readonly<Record<string, unknown>> = {}): void {
    console.error(formatLogLine("error", message, details));
  }
}
