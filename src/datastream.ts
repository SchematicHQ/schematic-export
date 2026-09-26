// Minimal read-only client for the Schematic datastream (the WebSocket the
// SDKs and the replicator use). It requests flags, companies, and users and
// returns the raw payloads, which are the exact objects the replicator writes
// to Redis and the SDKs evaluate flags against.

import WebSocket from "ws";

const ENTITY = {
  company: "rulesengine.Company",
  user: "rulesengine.User",
  flags: "rulesengine.Flags",
} as const;

const REQUEST_TIMEOUT_MS = 30_000;

type Raw = Record<string, unknown>;

interface Message {
  data: unknown;
  entity_id?: string;
  entity_type: string;
  message_type: string;
}

interface Pending {
  resolve(value: Raw): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export function datastreamUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  const host = url.hostname.split(".");
  if (host.length > 1 && host[0] === "api") host[0] = "datastream";
  url.hostname = host.join(".");
  url.pathname = "/datastream";
  return url.toString();
}

function pendingKey(entityType: string, key: string, value: string): string {
  return `${entityType}|${key.toLowerCase()}|${value.toLowerCase()}`;
}

export class DatastreamReader {
  private ws?: WebSocket;
  private readonly pending = new Map<string, Pending>();
  private flagsWaiter?: Pending;

  constructor(
    private readonly apiKey: string,
    private readonly apiUrl: string,
    private readonly version: string,
  ) {}

  async connect(): Promise<void> {
    const ws = new WebSocket(datastreamUrl(this.apiUrl), {
      headers: {
        "X-Schematic-Api-Key": this.apiKey,
        "X-Schematic-Client": "schematic-export",
        "X-Schematic-Client-Version": this.version,
        "X-Schematic-Datastream-Mode": "datastream",
      },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) => reject(new Error(`datastream rejected connection: ${res.statusCode}`)));
    });
    ws.on("message", (data) => this.handle(data.toString()));
    ws.on("close", () => this.failAll(new Error("datastream connection closed")));
    this.ws = ws;
  }

  close(): void {
    this.ws?.close();
  }

  fetchFlags(): Promise<Raw[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for flags")), REQUEST_TIMEOUT_MS);
      this.flagsWaiter = { resolve: (v) => resolve(v as unknown as Raw[]), reject, timer };
      this.send({ entity_type: ENTITY.flags });
    });
  }

  fetchCompany(key: string, value: string): Promise<Raw> {
    return this.fetchEntity(ENTITY.company, key, value);
  }

  fetchUser(key: string, value: string): Promise<Raw> {
    return this.fetchEntity(ENTITY.user, key, value);
  }

  private fetchEntity(entityType: string, key: string, value: string): Promise<Raw> {
    const id = pendingKey(entityType, key, value);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${entityType} ${key}=${value}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ entity_type: entityType, keys: { [key]: value } });
    });
  }

  private send(data: Raw): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("datastream is not connected");
    this.ws.send(JSON.stringify({ data }));
  }

  private handle(text: string): void {
    let msg: Message;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (msg.message_type === "error") {
      const err = (msg.data ?? {}) as { error?: string; keys?: Record<string, string>; entity_type?: string };
      for (const [k, v] of Object.entries(err.keys ?? {})) {
        this.settle(pendingKey(err.entity_type ?? msg.entity_type, k, v), undefined, new Error(err.error ?? "datastream error"));
      }
      return;
    }

    // Partial and delete messages are live updates for entities we already
    // fetched. A snapshot only needs the full payloads.
    if (msg.message_type !== "full") return;

    if (msg.entity_type === ENTITY.flags && this.flagsWaiter) {
      clearTimeout(this.flagsWaiter.timer);
      this.flagsWaiter.resolve((Array.isArray(msg.data) ? msg.data : []) as unknown as Raw);
      this.flagsWaiter = undefined;
      return;
    }

    if (msg.entity_type === ENTITY.company || msg.entity_type === ENTITY.user) {
      const entity = msg.data as Raw;
      for (const [k, v] of Object.entries((entity.keys as Record<string, string>) ?? {})) {
        this.settle(pendingKey(msg.entity_type, k, v), entity);
      }
    }
  }

  private settle(id: string, value?: Raw, err?: Error): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(value!);
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
    if (this.flagsWaiter) {
      clearTimeout(this.flagsWaiter.timer);
      this.flagsWaiter.reject(err);
      this.flagsWaiter = undefined;
    }
  }
}
