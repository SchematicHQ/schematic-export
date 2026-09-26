// Read-only client for the Schematic REST API. It only ever issues GET
// requests, so running an export can never change anything in Schematic.

export const DEFAULT_API_URL = "https://api.schematichq.com";
const MAX_PAGE_SIZE = 250;
const MAX_RETRIES = 5;

export interface ApiClientOptions {
  apiKey: string;
  baseUrl?: string;
  log?: (msg: string) => void;
}

type Params = Record<string, string | number | boolean | undefined>;

export class ApiClient {
  readonly apiKey: string;
  readonly baseUrl: string;
  private readonly log: (msg: string) => void;

  constructor(opts: ApiClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
    this.log = opts.log ?? (() => {});
  }

  async get<T = unknown>(path: string, params: Params = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method: "GET",
        headers: { "X-Schematic-Api-Key": this.apiKey, Accept: "application/json" },
      });

      if (res.ok) {
        const body = (await res.json()) as { data: T };
        return body.data;
      }

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) {
        const text = await res.text().catch(() => "");
        throw new Error(`GET ${url.pathname} failed with ${res.status}: ${text.slice(0, 300)}`);
      }

      const retryAfter = Number(res.headers.get("retry-after"));
      const delayMs = retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
      this.log(`GET ${url.pathname} returned ${res.status}, retrying in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }

  // Yields every item from a limit/offset list endpoint, one page at a time.
  async *paginate<T = Record<string, unknown>>(path: string, params: Params = {}): AsyncGenerator<T[]> {
    for (let offset = 0; ; offset += MAX_PAGE_SIZE) {
      const page = await this.get<T[]>(path, { ...params, limit: MAX_PAGE_SIZE, offset });
      if (page.length > 0) yield page;
      if (page.length < MAX_PAGE_SIZE) return;
    }
  }

  async listAll<T = Record<string, unknown>>(path: string, params: Params = {}): Promise<T[]> {
    const all: T[] = [];
    for await (const page of this.paginate<T>(path, params)) all.push(...page);
    return all;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
