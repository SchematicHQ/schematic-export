# schematic-export

Your Schematic data is yours. `schematic-export` keeps a copy of it on your own infrastructure, so your app keeps running and your options stay open, whatever happens.

## Start with the replicator

The [replicator](https://docs.schematichq.com/developer_resources/sdks/cross-platform-features#replicator) is the foundation. It keeps a complete copy of your flags, companies, and users in your own Redis, and backend SDKs in replicator mode evaluate flags from that copy instead of calling Schematic. If Schematic is ever unreachable, your flag checks keep working from what's already in your Redis, and `track` calls keep counting usage locally.

If you run the replicator, you're already covered for keeping your app running. This tool adds the rest:

- **Config export.** Plans, plan versions and their entitlements, add-ons, features, flags, credits, companies, company overrides, users, billing product mappings, and webhooks, as JSON. Everything you'd need to rebuild your pricing elsewhere.
- **Usage export.** Your event history and each company's current usage against its limits.
- **Snapshot.** A copy of the cache your SDKs evaluate flags against, and a `restore` command that writes it into Redis. Take it from your replicator, or build it straight from Schematic if you don't run the replicator yet.

The tool only reads from Schematic. It never creates, changes, or deletes anything.

## Requirements

- Node.js 20.12 or later
- A Schematic API key. A [read-only key](https://docs.schematichq.com/api-reference/authentication) is all it needs.
- Redis, to restore a snapshot

## Install

```bash
git clone https://github.com/SchematicHQ/schematic-export.git
cd schematic-export
npm install && npm run build
```

Run every command from the repo directory.

## Usage

We recommend keeping your API key in a `.env` file in the repo directory. It's already gitignored.

```bash
SCHEMATIC_API_KEY=sch_...
```

(Exporting `SCHEMATIC_API_KEY` in your shell works too.)

Then run everything at once:

```bash
node dist/cli.js all --out ./schematic-export
```

If you run the replicator, add `--redis redis://your-redis:6379` so the snapshot is a backup of your replicator's cache. See [Two ways to take a snapshot](#two-ways-to-take-a-snapshot).

Each run writes to a timestamped directory and updates `latest.json` to point at it:

```
schematic-export/
  latest.json
  2026-09-29T19-40-02-118Z/
    run.json               account, environment, and counts
    config/                plans.json, plan-version-entitlements.json, companies.json, ...
    usage/                 events.jsonl, current-usage.json
    snapshot/              manifest.json, flags.json, companies.json, users.json
```

Every run logs the account and environment it's exporting, so you can confirm you're using the key you meant to.

### Commands

| Command | What it does |
|---|---|
| `all` | Runs `config`, `usage`, and `snapshot`. Schedule this one. |
| `config` | Exports plan configuration and account data. |
| `usage` | Exports events and current usage per company. `--since <date>` limits how far back events go. |
| `snapshot` | Takes a snapshot from your replicator (`--redis <url>`) or from Schematic. |
| `restore` | Writes a snapshot back into Redis. `--from <dir>`, `--redis <url>`, `--prefix <prefix>`. |
| `serve-health` | Serves the replicator's health endpoint from a snapshot, for when the replicator itself isn't running. `--from <dir>`, `--port <port>`. |

`--out` takes a local directory or an S3 location (`s3://bucket/prefix`). S3 uses the standard AWS credential chain.

## Run it on a schedule

Run `all` daily from cron or CI and keep the output somewhere you control. If you run the replicator, schedule it somewhere that can reach the replicator's Redis and pass `--redis`.

```yaml
# .github/workflows/schematic-export.yml
name: schematic-export
on:
  schedule:
    - cron: "0 6 * * *"
jobs:
  export:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          repository: SchematicHQ/schematic-export
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci && npm run build
      - run: node dist/cli.js all --out s3://my-bucket/schematic
        env:
          SCHEMATIC_API_KEY: ${{ secrets.SCHEMATIC_READONLY_API_KEY }}
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: us-east-1
```

Turn on bucket versioning to keep a history of runs.

## Two ways to take a snapshot

Both produce a snapshot in the same format, and `restore` works the same way for either.

**From your replicator.** If you run the replicator, back up its Redis. The snapshot is an exact copy of the cache your SDKs already read.

```bash
node dist/cli.js snapshot --redis redis://your-redis:6379 --out ./schematic-export
```

**From Schematic.** If you don't run the replicator yet, the tool builds the same cache directly from Schematic, using the same data stream the replicator reads. Restoring it gives you a replicator cache without ever having run one.

```bash
node dist/cli.js snapshot --out ./schematic-export
```

## Restore from a snapshot

Restore a snapshot to rebuild your replicator's cache if it's ever lost, or to start serving from a replicator cache if you weren't running one. Either way:

1. Write the snapshot into Redis. Keys are written with no expiry, exactly as the replicator stores them.

   ```bash
   node dist/cli.js restore --from s3://my-bucket/schematic --redis redis://localhost:6379
   ```

2. If the replicator isn't running, start the health endpoint in its place. Your SDKs poll it to learn the cache is ready and which cache version to read.

   ```bash
   node dist/cli.js serve-health --from s3://my-bucket/schematic --port 8090
   ```

3. Your SDKs keep working in replicator mode, reading from Redis:

   ```ts
   import { createClient } from "redis";
   import { SchematicClient } from "@schematichq/schematic-typescript-node";

   const redisClient = createClient({ url: "redis://localhost:6379" });
   await redisClient.connect();

   const schematic = new SchematicClient({
     apiKey: process.env.SCHEMATIC_API_KEY,
     useDataStream: true,
     dataStream: {
       replicatorMode: true,
       redisClient,
       replicatorHealthURL: "http://localhost:8090/health",
     },
     flagDefaults: { "some-flag": false },
   });
   ```

### What to expect while running from a snapshot

- Backend SDKs in replicator mode (Go, Node, Python, Java, and C#) evaluate every flag, entitlement, and override from the snapshot, and `track` calls keep counting usage locally.
- Your plans and customers stay as they were when the snapshot was taken. New customers and plan changes are made in Schematic, or in whatever you move to.
- Usage periods reset in Schematic, so monthly counts keep accumulating until you're back on Schematic or migrated.
- Frontend SDKs check flags with Schematic directly. Set [flag defaults](https://docs.schematichq.com/production_readiness/availability) so client-side checks always resolve to the behavior you choose.
- Keep your SDK version steady while serving from a snapshot. The snapshot records its cache version in `manifest.json`.

## Verifying a snapshot

Run `scripts/verify-replicator.ts` after `restore` to check a snapshot end to end. It runs the Node SDK in replicator mode with the Schematic API and event capture pointed at an unreachable address, and compares every company and flag against the live API.

```bash
npx tsx scripts/verify-replicator.ts ./schematic-export redis://localhost:6379
```

## License

MIT
