// Stands in for the replicator's health endpoint. SDKs in replicator mode poll
// it to learn that the cache is ready and which cache version to read, so it
// must report the version the snapshot was restored with.

import { createServer } from "node:http";

export function serveHealth(port: number, cacheVersion: string, log: (msg: string) => void): void {
  const body = JSON.stringify({ ready: true, cache_version: cacheVersion, source: "schematic-export" });

  createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/ready")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }
    res.writeHead(404).end();
  }).listen(port, () => log(`serving replicator health on http://localhost:${port}/health (cache version ${cacheVersion})`));
}
