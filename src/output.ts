// Output destinations. Every export is written to a local directory first.
// For an s3:// destination, that directory is a temp dir that gets uploaded
// when the run finishes.

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface S3Location {
  bucket: string;
  prefix: string;
}

export function parseS3(dest: string): S3Location | undefined {
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(dest);
  if (!m) return undefined;
  return { bucket: m[1], prefix: m[2].replace(/\/$/, "") };
}

function s3Key(loc: S3Location, rel: string): string {
  return loc.prefix ? `${loc.prefix}/${rel}` : rel;
}

// A single export run, written to <dest>/<runId>/.
export class Run {
  readonly runId: string;
  private readonly root: string;

  private constructor(
    private readonly dest: string,
    private readonly s3: S3Location | undefined,
    private readonly staging: string,
    runId: string,
  ) {
    this.runId = runId;
    this.root = join(staging, runId);
  }

  static async start(dest: string): Promise<Run> {
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const s3 = parseS3(dest);
    const staging = s3 ? await mkdtemp(join(tmpdir(), "schematic-export-")) : dest;
    return new Run(dest, s3, staging, runId);
  }

  get location(): string {
    return this.s3 ? `s3://${this.s3.bucket}/${s3Key(this.s3, this.runId)}` : join(this.dest, this.runId);
  }

  async writeJson(rel: string, data: unknown): Promise<void> {
    const path = join(this.root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2) + "\n");
  }

  // Newline-delimited JSON, for exports too large to hold in memory.
  async openJsonl(rel: string): Promise<{ write(item: unknown): Promise<void>; close(): Promise<void> }> {
    const path = join(this.root, rel);
    await mkdir(dirname(path), { recursive: true });
    const stream = createWriteStream(path);
    return {
      write: (item) =>
        new Promise((resolve, reject) => {
          stream.write(JSON.stringify(item) + "\n", (err) => (err ? reject(err) : resolve()));
        }),
      close: () => new Promise((resolve) => stream.end(resolve)),
    };
  }

  // Uploads to S3 if needed, then points latest.json at this run.
  async finish(): Promise<void> {
    const latest = { run_id: this.runId, finished_at: new Date().toISOString() };
    if (!this.s3) {
      await writeFile(join(this.dest, "latest.json"), JSON.stringify(latest, null, 2) + "\n");
      return;
    }

    const client = new S3Client({});
    for (const file of await listFiles(this.root)) {
      const rel = relative(this.staging, file);
      await client.send(
        new PutObjectCommand({ Bucket: this.s3.bucket, Key: s3Key(this.s3, rel), Body: createReadStream(file) }),
      );
    }
    await client.send(
      new PutObjectCommand({
        Bucket: this.s3.bucket,
        Key: s3Key(this.s3, "latest.json"),
        Body: JSON.stringify(latest, null, 2) + "\n",
        ContentType: "application/json",
      }),
    );
    await rm(this.staging, { recursive: true, force: true });
  }
}

// Reads a file from a run. `source` is either a run directory / s3 run prefix,
// or the top-level export destination, in which case latest.json picks the run.
export async function readFromRun(source: string, rel: string): Promise<string> {
  const s3 = parseS3(source);
  if (s3) {
    const client = new S3Client({});
    const get = async (key: string) => {
      const res = await client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: key }));
      return res.Body!.transformToString();
    };
    const runPrefix = await get(s3Key(s3, "latest.json"))
      .then((body) => s3Key(s3, JSON.parse(body).run_id))
      .catch(() => s3.prefix);
    return get(runPrefix ? `${runPrefix}/${rel}` : rel);
  }

  const runDir = await readFile(join(source, "latest.json"), "utf8")
    .then((body) => join(source, JSON.parse(body).run_id))
    .catch(() => source);
  return readFile(join(runDir, rel), "utf8");
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}
