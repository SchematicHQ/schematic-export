// Takes an SDK snapshot: every flag, company, and user in the exact form the
// replicator caches them. `restore` loads a snapshot into Redis so SDKs in
// replicator mode keep evaluating flags without the Schematic API.

import { RulesEngineClient } from "@schematichq/schematic-typescript-node";
import type { ApiClient } from "../api.js";
import { DatastreamReader } from "../datastream.js";
import type { Run } from "../output.js";

type Row = Record<string, unknown>;

const CONCURRENCY = 10;
export const SNAPSHOT_FORMAT = "schematic-replicator-cache";
export const SNAPSHOT_FORMAT_VERSION = 1;

export async function takeSnapshot(
  api: ApiClient,
  run: Run,
  log: (msg: string) => void,
  toolVersion: string,
): Promise<Record<string, unknown>> {
  const engine = new RulesEngineClient();
  await engine.initialize();
  const cacheVersion = engine.getVersionKey();

  const whoami = await api.get<Row>("/whoami");
  const companies = await api.listAll<Row>("/companies");
  const users = await api.listAll<Row>("/users");

  const reader = new DatastreamReader(api.apiKey, api.baseUrl, toolVersion);
  await reader.connect();
  const errors: string[] = [];

  try {
    log("snapshot: flags");
    const flags = await reader.fetchFlags();
    await run.writeJson("snapshot/flags.json", flags);

    const companyOut = await run.openJsonl("snapshot/companies.jsonl");
    const companyCount = await fetchAll(companies, "company", (k, v) => reader.fetchCompany(k, v), companyOut, errors, log);
    await companyOut.close();

    const userOut = await run.openJsonl("snapshot/users.jsonl");
    const userCount = await fetchAll(users, "user", (k, v) => reader.fetchUser(k, v), userOut, errors, log);
    await userOut.close();

    const manifest = {
      format: SNAPSHOT_FORMAT,
      format_version: SNAPSHOT_FORMAT_VERSION,
      cache_version: cacheVersion,
      exported_at: new Date().toISOString(),
      account_id: whoami.account_id,
      environment_id: whoami.environment_id,
      tool_version: toolVersion,
      counts: { flags: flags.length, companies: companyCount, users: userCount },
      errors,
    };
    await run.writeJson("snapshot/manifest.json", manifest);
    return manifest;
  } finally {
    reader.close();
  }
}

async function fetchAll(
  entities: Row[],
  type: "company" | "user",
  fetch: (key: string, value: string) => Promise<Row>,
  out: { write(item: unknown): Promise<void> },
  errors: string[],
  log: (msg: string) => void,
): Promise<number> {
  let written = 0;
  const queue = [...entities];

  async function worker(): Promise<void> {
    for (let entity = queue.shift(); entity; entity = queue.shift()) {
      const keys = (entity.keys as Row[] | undefined) ?? [];
      if (keys.length === 0) {
        // The SDKs look entities up by key, so one without keys can't be checked.
        continue;
      }
      const { key, value } = keys[0] as { key: string; value: string };
      try {
        await out.write(await fetch(key, value));
        written++;
        if (written % 100 === 0) log(`snapshot: ${written} ${type === "company" ? "companies" : "users"}`);
      } catch (err) {
        errors.push(`${type} ${entity.id}: ${(err as Error).message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  log(`snapshot: ${written} ${type === "company" ? "companies" : "users"} done`);
  return written;
}
