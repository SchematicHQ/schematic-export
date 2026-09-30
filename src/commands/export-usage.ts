// Exports usage data: the raw event history, and each company's current
// usage against its limits (what you need to keep enforcing limits).

import { type Api, listAll, paginate, REQUEST_OPTIONS as opts } from "../api.js";
import type { Run } from "../output.js";

export interface UsageOptions {
  // Stop at events captured before this date. Events come back newest first.
  since?: Date;
}

export async function exportUsage(
  api: Api,
  run: Run,
  log: (msg: string) => void,
  options: UsageOptions = {},
): Promise<Record<string, number | string | null>> {
  const { client } = api;
  const events = await run.openJsonl("usage/events.jsonl");
  let eventCount = 0;
  let oldest: Date | null = null;

  try {
    pages: for await (const page of paginate((p) => client.events.listEvents(p, opts))) {
      // API key details and the truncated preview aren't part of the event.
      for (const { apiKey: _key, apiKeyView: _keyView, bodyPreview: _preview, ...event } of page) {
        if (options.since && event.capturedAt < options.since) break pages;
        await events.write(event);
        eventCount++;
        oldest = event.capturedAt;
      }
      log(`usage: ${eventCount} events (back to ${oldest?.toISOString()})`);
    }
  } finally {
    await events.close();
  }

  // Current-period usage per company and feature, from each company's entitlements.
  log("usage: current usage per company");
  const companies = await listAll((p) => client.companies.listCompanies(p, opts));
  const current = companies.map((c) => ({
    companyId: c.id,
    name: c.name,
    keys: Object.fromEntries(c.keys.map((k) => [k.key, k.value])),
    usage: (c.entitlements ?? []).map((e) => ({
      featureId: e.featureId,
      featureKey: e.featureKey,
      eventSubtype: e.eventSubtype,
      valueType: e.valueType,
      usage: e.usage,
      allocation: e.allocation,
      softLimit: e.softLimit,
      metricPeriod: e.metricPeriod,
      monthReset: e.monthReset,
      metricResetAt: e.metricResetAt,
      creditId: e.creditId,
      creditUsed: e.creditUsed,
      creditRemaining: e.creditRemaining,
      creditTotal: e.creditTotal,
    })),
    creditBalances: c.billingCreditBalances ?? null,
  }));
  await run.writeJson("usage/current-usage.json", current);

  return {
    "events.jsonl": eventCount,
    since: options.since?.toISOString() ?? null,
    oldestEvent: oldest?.toISOString() ?? null,
    "current-usage.json": current.length,
  };
}
