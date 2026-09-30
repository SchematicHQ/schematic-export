// Schematic API access through the official Node SDK. The export only calls
// list and get methods, so running it never changes anything in Schematic.

import { SchematicClient } from "@schematichq/schematic-typescript-node";

export const DEFAULT_API_URL = "https://api.schematichq.com";
const PAGE_SIZE = 250;

// Passed to every request. The SDK retries 408, 429, and 5xx responses.
export const REQUEST_OPTIONS = { maxRetries: 5, timeoutInSeconds: 60 };

export interface Api {
  client: SchematicClient;
  apiKey: string;
  baseUrl: string;
}

export function createApi(apiKey: string, baseUrl = DEFAULT_API_URL): Api {
  return { client: new SchematicClient({ apiKey, basePath: baseUrl }), apiKey, baseUrl };
}

type Page = { limit: number; offset: number };

// Yields every page from a limit/offset list method.
export async function* paginate<T>(fetchPage: (page: Page) => Promise<{ data: T[] }>): AsyncGenerator<T[]> {
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data } = await fetchPage({ limit: PAGE_SIZE, offset });
    if (data.length > 0) yield data;
    if (data.length < PAGE_SIZE) return;
  }
}

export async function listAll<T>(fetchPage: (page: Page) => Promise<{ data: T[] }>): Promise<T[]> {
  const all: T[] = [];
  for await (const page of paginate(fetchPage)) all.push(...page);
  return all;
}
