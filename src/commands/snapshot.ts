// Takes a snapshot of the cache SDKs evaluate flags against: every flag,
// company, and user. `restore` writes a snapshot into Redis in the
// replicator's layout, so SDKs in replicator mode can serve from it.
//
// A snapshot can come from two places, and both produce the same files:
//
//   - Your replicator's Redis (--redis). A backup of the cache you already run.
//   - Schematic itself. Builds the same cache from the datastream the
//     replicator reads from, for teams that don't run the replicator yet.
//
// Entities keep the datastream's wire format (snake_case), because that is
// what the replicator stores and what every SDK reads.

import { RulesEngineClient, type Schematic } from "@schematichq/schematic-typescript-node";
import { createClient } from "redis";
import { type Api, listAll, REQUEST_OPTIONS as opts } from "../api.js";
import { DEFAULT_PREFIX } from "../cache-keys.js";
import { DatastreamReader } from "../datastream.js";
import type { Run } from "../output.js";

export const SNAPSHOT_FORMAT = "schematic-replicator-cache";
export const SNAPSHOT_FORMAT_VERSION = 2;
const BATCH_SIZE = 500;
const CONCURRENCY = 10;

type Entity = Record<string, unknown>;

interface CacheData {
  cacheVersion: string;
  flags: Entity[];
  companies: Entity[];
  users: Entity[];
  errors: string[];
}

export interface SnapshotOptions {
  // Back up this replicator Redis. Without it, the snapshot is built from Schematic.
  redisUrl?: string;
  prefix?: string;
  // Only needed if the replicator cache holds more than one version, e.g. mid-upgrade.
  cacheVersion?: string;
}

export async function takeSnapshot(
  run: Run,
  log: (msg: string) => void,
  options: SnapshotOptions,
  schematic?: { api: Api; toolVersion: string },
): Promise<Record<string, unknown>> {
  let data: CacheData;
  if (options.redisUrl) {
    data = await fromReplicator(options.redisUrl, options.prefix ?? DEFAULT_PREFIX, log, options.cacheVersion);
  } else if (schematic) {
    data = await fromSchematic(schematic.api, schematic.toolVersion, log);
  } else {
    throw new Error("a snapshot needs either --redis or a Schematic API key");
  }

  await run.writeJson("snapshot/flags.json", data.flags);
  await run.writeJson("snapshot/companies.json", data.companies);
  await run.writeJson("snapshot/users.json", data.users);

  const manifest = {
    format: SNAPSHOT_FORMAT,
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    source: options.redisUrl ? "replicator" : "schematic",
    cacheVersion: data.cacheVersion,
    exportedAt: new Date().toISOString(),
    environmentId: data.companies[0]?.environment_id ?? null,
    counts: { flags: data.flags.length, companies: data.companies.length, users: data.users.length },
    errors: data.errors,
  };
  await run.writeJson("snapshot/manifest.json", manifest);
  log(`snapshot: ${data.flags.length} flags, ${data.companies.length} companies, ${data.users.length} users`);
  return manifest;
}

// --- From your replicator's Redis ---

async function fromReplicator(
  redisUrl: string,
  prefix: string,
  log: (msg: string) => void,
  requestedVersion?: string,
): Promise<CacheData> {
  const redis = createClient({ url: redisUrl });
  await redis.connect();

  try {
    // Keys look like {prefix}{type}:{version}:{rest}. Companies and users are
    // stored once by ID ({rest} is the ID) plus one lookup key per entity key,
    // which restore rebuilds, so only the ID and flag keys are read.
    const byVersion = new Map<string, { flags: string[]; company: string[]; user: string[] }>();
    for await (const batch of redis.scanIterator({ MATCH: `${prefix}*`, COUNT: 1000 })) {
      for (const key of batch) {
        const [type, version, ...rest] = key.slice(prefix.length).split(":");
        if (type !== "flags" && type !== "company" && type !== "user") continue;
        if (type !== "flags" && rest.length !== 1) continue;
        if (!byVersion.has(version)) byVersion.set(version, { flags: [], company: [], user: [] });
        byVersion.get(version)![type].push(key);
      }
    }

    const cacheVersion = pickVersion([...byVersion.keys()], requestedVersion);
    const keys = byVersion.get(cacheVersion)!;
    log(`snapshot: reading replicator cache, version ${cacheVersion}`);

    const mGet = (batch: string[]) => redis.mGet(batch);
    return {
      cacheVersion,
      flags: await readAll(mGet, keys.flags),
      companies: await readAll(mGet, keys.company),
      users: await readAll(mGet, keys.user),
      errors: [],
    };
  } finally {
    await redis.quit();
  }
}

function pickVersion(found: string[], requested?: string): string {
  if (requested) {
    if (!found.includes(requested)) throw new Error(`no cache entries for version ${requested} (found: ${found.join(", ") || "none"})`);
    return requested;
  }
  if (found.length === 0) throw new Error("no replicator cache entries found. Is the replicator writing to this Redis, and is --prefix right?");
  if (found.length > 1) throw new Error(`the cache holds several versions (${found.join(", ")}). Pass --cache-version with the one your replicator reports at /health.`);
  return found[0];
}

async function readAll(mGet: (keys: string[]) => Promise<(string | null)[]>, keys: string[]): Promise<Entity[]> {
  const out: Entity[] = [];
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const values = await mGet(keys.slice(i, i + BATCH_SIZE));
    for (const value of values) if (value) out.push(JSON.parse(value) as Entity);
  }
  return out;
}

// --- From Schematic ---

type Keyed = { id: string; keys: Schematic.EntityKeyDetailResponseData[] };

async function fromSchematic(api: Api, toolVersion: string, log: (msg: string) => void): Promise<CacheData> {
  const { client } = api;
  const engine = new RulesEngineClient();
  await engine.initialize();

  const companies = await listAll((p) => client.companies.listCompanies(p, opts));
  const users = await listAll((p) => client.companies.listUsers(p, opts));

  const reader = new DatastreamReader(api.apiKey, api.baseUrl, toolVersion);
  await reader.connect();
  const errors: string[] = [];

  try {
    log("snapshot: building cache from Schematic");
    return {
      cacheVersion: engine.getVersionKey(),
      flags: await reader.fetchFlags(),
      companies: await fetchAll(companies, "company", (k, v) => reader.fetchCompany(k, v), errors, log),
      users: await fetchAll(users, "user", (k, v) => reader.fetchUser(k, v), errors, log),
      errors,
    };
  } finally {
    reader.close();
  }
}

async function fetchAll(
  entities: Keyed[],
  type: "company" | "user",
  fetch: (key: string, value: string) => Promise<Entity>,
  errors: string[],
  log: (msg: string) => void,
): Promise<Entity[]> {
  const label = type === "company" ? "companies" : "users";
  const out: Entity[] = [];
  const queue = [...entities];

  async function worker(): Promise<void> {
    for (let entity = queue.shift(); entity; entity = queue.shift()) {
      // SDKs look entities up by key, so one without keys is never checked.
      const [first] = entity.keys;
      if (!first) continue;
      try {
        out.push(await fetch(first.key, first.value));
        if (out.length % 100 === 0) log(`snapshot: ${out.length} ${label}`);
      } catch (err) {
        errors.push(`${type} ${entity.id}: ${(err as Error).message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}
