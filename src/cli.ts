#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command, InvalidArgumentError } from "commander";
import { type Api, createApi, DEFAULT_API_URL, REQUEST_OPTIONS } from "./api.js";
import { exportConfig } from "./commands/export-config.js";
import { exportUsage } from "./commands/export-usage.js";
import { readManifest, restore } from "./commands/restore.js";
import { serveHealth } from "./commands/serve-health.js";
import { takeSnapshot } from "./commands/snapshot.js";
import { Run } from "./output.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const log = (msg: string) => console.error(msg);

// Load ./.env if present. Variables already set in the environment take precedence.
try {
  process.loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

function api(): Api {
  const apiKey = process.env.SCHEMATIC_API_KEY;
  if (!apiKey) {
    console.error("SCHEMATIC_API_KEY is not set. Use a read-only API key.");
    process.exit(1);
  }
  return createApi(apiKey, process.env.SCHEMATIC_API_URL ?? DEFAULT_API_URL);
}

function parseDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new InvalidArgumentError("expected a date, e.g. 2026-01-31");
  return date;
}

// Connects to the Schematic API and logs which account and environment it is
// exporting, so a run with the wrong key is obvious right away.
async function withApi<T>(fn: (api: Api, source: Record<string, unknown>) => Promise<T>): Promise<T> {
  const schematic = api();
  try {
    const { data: whoami } = await schematic.client.accounts.getWhoAmI(REQUEST_OPTIONS);
    const environment = whoami.environments?.find((e) => e.id === whoami.environmentId);
    const source = {
      accountId: whoami.accountId,
      accountName: whoami.accountName,
      environmentId: whoami.environmentId,
      environmentName: environment?.name ?? null,
    };
    log(`exporting account "${source.accountName}" (${source.accountId}), environment "${source.environmentName}"`);
    return await fn(schematic, source);
  } finally {
    await schematic.client.close();
  }
}

async function withRun(out: string, fn: (run: Run) => Promise<{ source?: unknown; summary: unknown }>): Promise<void> {
  const run = await Run.start(out);
  const { source, summary } = await fn(run);
  await run.writeJson("run.json", { runId: run.runId, toolVersion: version, source, summary });
  await run.finish();
  console.log(JSON.stringify({ location: run.location, summary }, null, 2));
}

const program = new Command()
  .name("schematic-export")
  .description("Keep a copy of your Schematic data: plan configuration, usage, and a backup of your replicator cache.")
  .version(version);

const outOption = ["-o, --out <dest>", "local directory or s3://bucket/prefix", "./schematic-export"] as const;
const sinceOption = ["--since <date>", "only export events captured on or after this date", parseDate] as const;
const prefixOption = ["--prefix <prefix>", "Redis key prefix", "schematic:"] as const;
const redisOption = ["--redis <url>", "your replicator's Redis, to back it up (otherwise the snapshot is built from Schematic)"] as const;

program
  .command("all")
  .description("run config, usage, and snapshot together (the one to schedule)")
  .option(...outOption)
  .option(...sinceOption)
  .option(...redisOption)
  .option(...prefixOption)
  .action((opts) =>
    withRun(opts.out, (run) =>
      withApi(async (schematic, source) => ({
        source,
        summary: {
          config: await exportConfig(schematic, run, log),
          usage: await exportUsage(schematic, run, log, { since: opts.since }),
          snapshot: await takeSnapshot(run, log, { redisUrl: opts.redis, prefix: opts.prefix }, { api: schematic, toolVersion: version }),
        },
      })),
    ),
  );

program
  .command("config")
  .description("export plans, plan versions, features, entitlements, add-ons, credits, companies, overrides, and flags")
  .option(...outOption)
  .action((opts) =>
    withRun(opts.out, (run) => withApi(async (schematic, source) => ({ source, summary: await exportConfig(schematic, run, log) }))),
  );

program
  .command("usage")
  .description("export event history and current usage per company")
  .option(...outOption)
  .option(...sinceOption)
  .action((opts) =>
    withRun(opts.out, (run) =>
      withApi(async (schematic, source) => ({ source, summary: await exportUsage(schematic, run, log, { since: opts.since }) })),
    ),
  );

program
  .command("snapshot")
  .description("snapshot the flags, companies, and users your SDKs evaluate, from your replicator or from Schematic")
  .option(...redisOption)
  .option(...prefixOption)
  .option("--cache-version <version>", "with --redis: cache version to back up, if Redis holds more than one")
  .option(...outOption)
  .action((opts) =>
    withRun(opts.out, async (run) => {
      const options = { redisUrl: opts.redis, prefix: opts.prefix, cacheVersion: opts.cacheVersion };
      if (opts.redis) return { source: { redis: redactUrl(opts.redis) }, summary: await takeSnapshot(run, log, options) };
      return withApi(async (schematic, source) => ({
        source,
        summary: await takeSnapshot(run, log, options, { api: schematic, toolVersion: version }),
      }));
    }),
  );

program
  .command("restore")
  .description("write a snapshot back into Redis for SDKs running in replicator mode")
  .requiredOption("--from <source>", "export destination or run directory (local or s3://)")
  .option("--redis <url>", "Redis URL", "redis://localhost:6379")
  .option(...prefixOption)
  .action(async (opts) => {
    const summary = await restore(opts.from, opts.redis, log, opts.prefix);
    console.log(JSON.stringify(summary, null, 2));
  });

program
  .command("serve-health")
  .description("serve the replicator's health endpoint for a restored snapshot, when the replicator itself isn't running")
  .requiredOption("--from <source>", "export destination or run directory the snapshot was restored from")
  .option("-p, --port <port>", "port", (v) => Number.parseInt(v, 10), 8090)
  .action(async (opts) => {
    const manifest = await readManifest(opts.from);
    serveHealth(opts.port, manifest.cacheVersion, log);
  });

// Keeps passwords in Redis URLs out of run.json.
function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.password) url.password = "****";
    return url.toString();
  } catch {
    return value;
  }
}

program.parseAsync().catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
