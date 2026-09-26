# schematic-export

Export your Schematic data on a schedule, so your app keeps working and you can migrate even if the Schematic API is unavailable.

`schematic-export` produces three things:

- **Config export.** Plans, plan versions and their entitlements, add-ons, features, flags, credits, companies, company overrides, users, billing product mappings, and webhooks, as JSON.
- **Usage export.** Your event history and each company's current usage against its limits.
- **SDK snapshot.** Every flag, company, and user in the exact form the SDKs read from Redis in replicator mode. Restore it into Redis and your backend keeps evaluating flags with no calls to Schematic.

The tool only reads from Schematic. It never creates, changes, or deletes anything.

## Requirements

- Node.js 20 or later
- A Schematic API key. Use a [read-only key](https://docs.schematichq.com/api-reference/authentication).
- Redis, only if you restore a snapshot

## Install

```bash
git clone https://github.com/SchematicHQ/schematic-export.git
cd schematic-export
npm install && npm run build
npm link
```

## Usage

Set your API key, then run everything at once:

```bash
export SCHEMATIC_API_KEY=sch_...
schematic-export all --out ./schematic-export
```

Each run writes to a timestamped directory and updates `latest.json` to point at it:

```
schematic-export/
  latest.json
  2026-09-25T21-40-02-118Z/
    run.json               account, environment, and counts
    config/                plans.json, plan-version-entitlements.json, companies.json, ...
    usage/                 events.jsonl, current-usage.json
    snapshot/              manifest.json, flags.json, companies.jsonl, users.jsonl
```

Every run logs the account and environment it is exporting. Check it the first time you run with a new key.

### Commands

| Command | What it does |
|---|---|
| `all` | Runs `config`, `usage`, and `snapshot`. Schedule this one. |
| `config` | Exports plan configuration and account data. |
| `usage` | Exports events and current usage per company. `--since <date>` limits how far back events go. |
| `snapshot` | Exports flags, companies, and users for SDK replicator mode. |
| `restore` | Loads a snapshot into Redis. `--from <dir>`, `--redis <url>`, `--prefix <prefix>`. |
| `serve-health` | Serves a replicator health endpoint for a restored snapshot. `--from <dir>`, `--port <port>`. |

`--out` takes a local directory or an S3 location (`s3://bucket/prefix`). S3 uses the standard AWS credential chain.

## Run it on a schedule

An export only helps if it exists before you need it. Run `all` daily from cron or CI and keep the output somewhere you control.

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
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx schematic-export all --out s3://my-bucket/schematic
        env:
          SCHEMATIC_API_KEY: ${{ secrets.SCHEMATIC_READONLY_API_KEY }}
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: us-east-1
```

Turn on bucket versioning if you want to keep a history of runs.

## Keep your app running from a snapshot

Backend SDKs in [replicator mode](https://docs.schematichq.com/developer_resources/sdks/cross-platform-features#replicator) evaluate flags locally from Redis. A restored snapshot gives them everything they need.

1. Load the latest snapshot into Redis. Keys are written with no expiry.

   ```bash
   schematic-export restore --from s3://my-bucket/schematic --redis redis://localhost:6379
   ```

2. Serve the health endpoint the SDKs poll. It tells them the cache is ready and which cache version the snapshot uses.

   ```bash
   schematic-export serve-health --from s3://my-bucket/schematic --port 8090
   ```

3. Point your SDK at Redis in replicator mode:

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

### Limitations

- Replicator mode is supported in the Go, Node, Python, Java, and C# SDKs.
- Frontend SDKs have no local mode. Client-side flag checks fall back to their defaults.
- Usage keeps counting locally, but periodic resets (for example, monthly limits) don't happen.
- A snapshot is a point in time. Plan changes made after it aren't reflected.
- Pin your SDK version while running from a snapshot. The snapshot is stored in the format of the rules engine version recorded in `manifest.json`, and a later SDK may expect a different format.

## Verifying a snapshot

Run `scripts/verify-replicator.ts` after `restore` to check a snapshot end to end. It runs the Node SDK in replicator mode with the API and event capture pointed at an unreachable address, and compares every company and flag against the live API.

```bash
SCHEMATIC_API_KEY=sch_... npx tsx scripts/verify-replicator.ts ./schematic-export redis://localhost:6379
```

## License

MIT
