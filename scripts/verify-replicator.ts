// End-to-end check that a restored snapshot keeps an app working without the
// Schematic API. Runs the real Node SDK in replicator mode against Redis, with
// the API and event capture pointed at an unreachable address, and compares
// every company/flag result against each company's feature access from the
// live API (GET /feature-usage).
//
// Usage: tsx scripts/verify-replicator.ts <export-dir> <redis-url>
// Reads SCHEMATIC_API_KEY from ./.env or the environment.

import { SchematicClient, type RedisClient } from "@schematichq/schematic-typescript-node";
import { createClient } from "redis";
import { createApi, listAll, REQUEST_OPTIONS as opts } from "../src/api.js";
import { readManifest } from "../src/commands/restore.js";
import { serveHealth } from "../src/commands/serve-health.js";

try {
  process.loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

const [exportDir = "./export", redisUrl = "redis://localhost:6379"] = process.argv.slice(2);
const UNREACHABLE = "http://127.0.0.1:9";
const HEALTH_PORT = 8091;

const { client: live } = createApi(process.env.SCHEMATIC_API_KEY!);
const { data: whoami } = await live.accounts.getWhoAmI(opts);
console.error(`oracle account: ${whoami.accountName} (${whoami.accountId})`);

// Oracle: which features each company has access to, according to the API.
const flags = await listAll((p) => live.features.listFlags(p, opts));
const featureFlags = flags.filter((f) => f.featureId);
const companies = await listAll((p) => live.companies.listCompanies(p, opts));
const expected = new Map<string, Map<string, boolean>>();
for (const company of companies) {
  const usage = await listAll((p) => live.entitlements.listFeatureUsage({ ...p, companyId: company.id }, opts));
  expected.set(company.id, new Map(usage.map((u) => [u.feature?.id ?? "", u.access])));
}

// Offline: SDK in replicator mode, reading only from the restored Redis.
const manifest = await readManifest(exportDir);
serveHealth(HEALTH_PORT, manifest.cacheVersion, console.error);

const redis = createClient({ url: redisUrl });
await redis.connect();
const client = new SchematicClient({
  apiKey: "offline-verification",
  basePath: UNREACHABLE,
  eventCaptureBaseURL: UNREACHABLE,
  useDataStream: true,
  dataStream: {
    replicatorMode: true,
    // The SDK's RedisClient type matches redis v4, where scanIterator yields single
    // keys. redis v5+ yields batches. Replicator mode never scans, so this is safe.
    redisClient: redis as unknown as RedisClient,
    replicatorHealthURL: `http://localhost:${HEALTH_PORT}/health`,
    replicatorHealthCheck: 500,
  },
});
await new Promise((resolve) => setTimeout(resolve, 1500));

let checked = 0;
let matched = 0;
const reasons = new Map<string, number>();
const mismatches: string[] = [];

for (const company of companies) {
  const [first] = company.keys;
  if (!first) continue;
  const evalKeys = { [first.key]: first.value };
  const access = expected.get(company.id)!;

  for (const flag of featureFlags) {
    const want = access.get(flag.featureId!);
    if (want === undefined) continue;
    const got = await client.checkFlagWithEntitlement({ company: evalKeys }, flag.key);
    checked++;
    reasons.set(got.reason, (reasons.get(got.reason) ?? 0) + 1);
    if (got.value === want) matched++;
    else mismatches.push(`${company.name} / ${flag.key}: offline=${got.value} (${got.reason}) api=${want}`);
  }
}

console.log(JSON.stringify({ checked, matched, mismatched: mismatches.length, reasons: Object.fromEntries(reasons), mismatches: mismatches.slice(0, 20) }, null, 2));
await client.close();
await live.close();
await redis.quit();
process.exit(mismatches.length ? 1 : 0);
