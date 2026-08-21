export interface LoggedRequest {
  readonly at: string;
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly userAgent: string;
  readonly forwardedFor: string;
}

/**
 * Bounded in-memory record of recent requests, used to diagnose what a remote
 * scraper actually asks for. Deliberately capped and never persisted.
 */
export class RequestLog {
  readonly #entries: LoggedRequest[] = [];
  readonly #limit: number;

  constructor(limit = 50) {
    this.#limit = limit;
  }

  record(entry: LoggedRequest): void {
    this.#entries.push(entry);
    if (this.#entries.length > this.#limit) {
      this.#entries.splice(0, this.#entries.length - this.#limit);
    }
  }

  list(): readonly LoggedRequest[] {
    return [...this.#entries].reverse();
  }
}
