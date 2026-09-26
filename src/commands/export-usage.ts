// Exports usage data: the raw event history, and each company's current
// usage against its limits (what you need to keep enforcing limits).

import type { ApiClient } from "../api.js";
import type { Run } from "../output.js";

type Row = Record<string, unknown>;

export interface UsageOptions {
  // Stop at events captured before this date. Events come back newest first.
  since?: Date;
}

export async function exportUsage(
  api: ApiClient,
  run: Run,
  log: (msg: string) => void,
  opts: UsageOptions = {},
): Promise<Record<string, number | string | null>> {
  const events = await run.openJsonl("usage/events.jsonl");
  let eventCount = 0;
  let oldest: string | null = null;

  try {
    pages: for await (const page of api.paginate<Row>("/events")) {
      for (const { api_key: _key, api_key_view: _keyView, body_preview: _preview, ...event } of page) {
        const capturedAt = String(event.captured_at);
        if (opts.since && new Date(capturedAt) < opts.since) break pages;
        await events.write(event);
        eventCount++;
        oldest = capturedAt;
      }
      log(`usage: ${eventCount} events (back to ${oldest})`);
    }
  } finally {
    await events.close();
  }

  // Current-period usage per company and feature, from each company's entitlements.
  log("usage: current usage per company");
  const companies = await api.listAll<Row>("/companies");
  const current = companies.map((c) => ({
    company_id: c.id,
    name: c.name,
    keys: Object.fromEntries(((c.keys as Row[]) ?? []).map((k) => [k.key, k.value])),
    usage: ((c.entitlements as Row[]) ?? []).map((e) => ({
      feature_id: e.feature_id,
      feature_key: e.feature_key,
      event_subtype: e.event_subtype,
      value_type: e.value_type,
      usage: e.usage,
      allocation: e.allocation,
      soft_limit: e.soft_limit,
      metric_period: e.metric_period,
      month_reset: e.month_reset,
      metric_reset_at: e.metric_reset_at,
      credit_id: e.credit_id,
      credit_used: e.credit_used,
      credit_remaining: e.credit_remaining,
      credit_total: e.credit_total,
    })),
    credit_balances: c.billing_credit_balances ?? null,
  }));
  await run.writeJson("usage/current-usage.json", current);

  return { "events.jsonl": eventCount, oldest_event: oldest, "current-usage.json": current.length };
}
