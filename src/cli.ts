#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command, InvalidArgumentError } from "commander";
import { ApiClient, DEFAULT_API_URL } from "./api.js";
import { exportConfig } from "./commands/export-config.js";
import { exportUsage } from "./commands/export-usage.js";
import { readManifest, restore } from "./commands/restore.js";
import { serveHealth } from "./commands/serve-health.js";
import { takeSnapshot } from "./commands/snapshot.js";
import { Run } from "./output.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const log = (msg: string) => console.error(msg);

function api(): ApiClient {
  const apiKey = process.env.SCHEMATIC_API_KEY;
  if (!apiKey) {
    console.error("SCHEMATIC_API_KEY is not set. Use a read-only API key.");
    process.exit(1);
  }
  return new ApiClient({ apiKey, baseUrl: process.env.SCHEMATIC_API_URL ?? DEFAULT_API_URL, log });
}

function parseDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new InvalidArgumentError("expected a date, e.g. 2026-01-31");
  return date;
}

async function withRun(out: string, fn: (run: Run, client: ApiClient) => Promise<unknown>): Promise<void> {
  const client = api();
  // Log the account up front so an export from the wrong key is obvious.
  const whoami = await client.get<Record<string, unknown>>("/whoami");
  const environments = (whoami.environments as Record<string, unknown>[] | undefined) ?? [];
  const environment = environments.find((e) => e.id === whoami.environment_id);
  const source = {
    account_id: whoami.account_id,
    account_name: whoami.account_name,
    environment_id: whoami.environment_id,
    environment_name: environment?.name ?? null,
  };
  log(`exporting account "${source.account_name}" (${source.account_id}), environment "${source.environment_name}"`);

  const run = await Run.start(out);
  const summary = await fn(run, client);
  await run.writeJson("run.json", { run_id: run.runId, tool_version: version, source, summary });
  await run.finish();
  console.log(JSON.stringify({ location: run.location, summary }, null, 2));
}

const program = new Command()
  .name("schematic-export")
  .description("Export your Schematic data so your app keeps running without the Schematic API.")
  .version(version);

const outOption = ["-o, --out <dest>", "local directory or s3://bucket/prefix", "./schematic-export"] as const;

program
  .command("all")
  .description("run config, usage, and snapshot exports together (the one to schedule)")
  .option(...outOption)
  .option("--since <date>", "only export events captured on or after this date", parseDate)
  .action((opts) =>
    withRun(opts.out, async (run, client) => {
      return {
        config: await exportConfig(client, run, log),
        usage: await exportUsage(client, run, log, { since: opts.since }),
        snapshot: await takeSnapshot(client, run, log, version),
      };
    }),
  );

program
  .command("config")
  .description("export plans, plan versions, features, entitlements, add-ons, credits, companies, overrides, and flags")
  .option(...outOption)
  .action((opts) => withRun(opts.out, (run, client) => exportConfig(client, run, log)));

program
  .command("usage")
  .description("export event history and current usage per company")
  .option(...outOption)
  .option("--since <date>", "only export events captured on or after this date", parseDate)
  .action((opts) => withRun(opts.out, (run, client) => exportUsage(client, run, log, { since: opts.since })));

program
  .command("snapshot")
  .description("export flags, companies, and users in the form SDKs in replicator mode read from Redis")
  .option(...outOption)
  .action((opts) => withRun(opts.out, (run, client) => takeSnapshot(client, run, log, version)));

program
  .command("restore")
  .description("load a snapshot into Redis for SDKs running in replicator mode")
  .requiredOption("--from <source>", "export destination or run directory (local or s3://)")
  .option("--redis <url>", "Redis URL", "redis://localhost:6379")
  .option("--prefix <prefix>", "Redis key prefix", "schematic:")
  .action(async (opts) => {
    const summary = await restore(opts.from, opts.redis, log, opts.prefix);
    console.log(JSON.stringify(summary, null, 2));
  });

program
  .command("serve-health")
  .description("serve a replicator health endpoint for a restored snapshot")
  .requiredOption("--from <source>", "export destination or run directory the snapshot was restored from")
  .option("-p, --port <port>", "port", (v) => Number.parseInt(v, 10), 8090)
  .action(async (opts) => {
    const manifest = await readManifest(opts.from);
    serveHealth(opts.port, manifest.cache_version, log);
  });

program.parseAsync().catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
