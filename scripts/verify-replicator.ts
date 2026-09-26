// End-to-end check that a restored snapshot keeps an app working without the
// Schematic API. Runs the real Node SDK in replicator mode against Redis, with
// the API and event capture pointed at an unreachable address, and compares
// every company/flag result against each company's feature access from the
// live API (GET /feature-usage).
//
// Usage: SCHEMATIC_API_KEY=... tsx scripts/verify-replicator.ts <export-dir> <redis-url>

import { SchematicClient } from "@schematichq/schematic-typescript-node";
import { createClient } from "redis";
import { ApiClient } from "../src/api.js";
import { readManifest } from "../src/commands/restore.js";
import { serveHealth } from "../src/commands/serve-health.js";

type Row = Record<string, unknown>;

const [exportDir = "./export", redisUrl = "redis://localhost:6379"] = process.argv.slice(2);
const UNREACHABLE = "http://127.0.0.1:9";
const HEALTH_PORT = 8091;

const api = new ApiClient({ apiKey: process.env.SCHEMATIC_API_KEY!, log: console.error });
const whoami = await api.get<Row>("/whoami");
console.error(`oracle account: ${whoami.account_name} (${whoami.account_id})`);

// Oracle: which features each company has access to, according to the API.
const flags = await api.listAll<Row>("/flags");
const featureFlags = flags.filter((f) => f.feature_id);
const companies = await api.listAll<Row>("/companies");
const expected = new Map<string, Map<string, boolean>>();
for (const company of companies) {
  const usage = await api.listAll<Row>("/feature-usage", { company_id: String(company.id) });
  expected.set(String(company.id), new Map(usage.map((u) => [String((u.feature as Row).id), Boolean(u.access)])));
}

// Offline: SDK in replicator mode, reading only from the restored Redis.
const manifest = await readManifest(exportDir);
serveHealth(HEALTH_PORT, manifest.cache_version, console.error);

const redis = createClient({ url: redisUrl });
await redis.connect();
const client = new SchematicClient({
  apiKey: "offline-verification",
  basePath: UNREACHABLE,
  eventCaptureBaseURL: UNREACHABLE,
  useDataStream: true,
  dataStream: {
    replicatorMode: true,
    redisClient: redis,
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
  const keys = (company.keys as Row[]) ?? [];
  if (keys.length === 0) continue;
  const evalKeys = { [String(keys[0].key)]: String(keys[0].value) };
  const access = expected.get(String(company.id))!;

  for (const flag of featureFlags) {
    const want = access.get(String(flag.feature_id));
    if (want === undefined) continue;
    const got = await client.checkFlagWithEntitlement({ company: evalKeys }, String(flag.key));
    checked++;
    reasons.set(got.reason, (reasons.get(got.reason) ?? 0) + 1);
    if (got.value === want) matched++;
    else mismatches.push(`${company.name} / ${flag.key}: offline=${got.value} (${got.reason}) api=${want}`);
  }
}

console.log(JSON.stringify({ checked, matched, mismatched: mismatches.length, reasons: Object.fromEntries(reasons), mismatches: mismatches.slice(0, 20) }, null, 2));
await client.close();
await redis.quit();
process.exit(mismatches.length ? 1 : 0);
