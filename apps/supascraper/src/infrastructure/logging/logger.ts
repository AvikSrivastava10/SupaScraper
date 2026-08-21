export interface Logger {
  info(message: string, details?: Readonly<Record<string, unknown>>): void;
  error(message: string, details?: Readonly<Record<string, unknown>>): void;
}

export class ConsoleLogger implements Logger {
  info(message: string, details: Readonly<Record<string, unknown>> = {}): void {
    console.info(JSON.stringify({ level: "info", message, ...details }));
  }

  error(message: string, details: Readonly<Record<string, unknown>> = {}): void {
    console.error(JSON.stringify({ level: "error", message, ...details }));
  }
}
