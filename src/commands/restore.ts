// Loads a snapshot into Redis using the replicator's key layout, with no
// expiry, so SDKs in replicator mode can evaluate flags from it indefinitely.

import { createClient } from "redis";
import { DEFAULT_PREFIX, flagKey, idKey, lookupKey } from "../cache-keys.js";
import { readFromRun } from "../output.js";
import { SNAPSHOT_FORMAT, SNAPSHOT_FORMAT_VERSION } from "./snapshot.js";

type Row = Record<string, unknown>;

export interface SnapshotManifest {
  format: string;
  format_version: number;
  cache_version: string;
  exported_at: string;
  counts: Record<string, number>;
}

export async function readManifest(source: string): Promise<SnapshotManifest> {
  const manifest = JSON.parse(await readFromRun(source, "snapshot/manifest.json")) as SnapshotManifest;
  if (manifest.format !== SNAPSHOT_FORMAT || manifest.format_version > SNAPSHOT_FORMAT_VERSION) {
    throw new Error(`unsupported snapshot format ${manifest.format} v${manifest.format_version}`);
  }
  return manifest;
}

export async function restore(
  source: string,
  redisUrl: string,
  log: (msg: string) => void,
  prefix = DEFAULT_PREFIX,
): Promise<Record<string, number>> {
  const manifest = await readManifest(source);
  const version = manifest.cache_version;
  log(`restore: snapshot from ${manifest.exported_at}, cache version ${version}`);

  const flags = JSON.parse(await readFromRun(source, "snapshot/flags.json")) as Row[];
  const companies = parseJsonl(await readFromRun(source, "snapshot/companies.jsonl"));
  const users = parseJsonl(await readFromRun(source, "snapshot/users.jsonl"));

  const redis = createClient({ url: redisUrl });
  await redis.connect();
  let keys = 0;

  try {
    const multi = redis.multi();

    for (const flag of flags) {
      multi.set(flagKey(prefix, version, String(flag.key)), JSON.stringify(flag));
      keys++;
    }

    for (const [type, entities] of [["company", companies], ["user", users]] as const) {
      for (const entity of entities) {
        const id = String(entity.id);
        multi.set(idKey(prefix, type, version, id), JSON.stringify(entity));
        keys++;
        for (const [k, v] of Object.entries((entity.keys as Record<string, string>) ?? {})) {
          multi.set(lookupKey(prefix, type, version, k, v), JSON.stringify(id));
          keys++;
        }
      }
    }

    await multi.exec();
  } finally {
    await redis.quit();
  }

  log(`restore: wrote ${keys} keys`);
  return { flags: flags.length, companies: companies.length, users: users.length, keys };
}

function parseJsonl(text: string): Row[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Row);
}
