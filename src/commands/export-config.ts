// Exports plan configuration and account data as JSON: everything you would
// need to rebuild your pricing and entitlements somewhere else.

import type { ApiClient } from "../api.js";
import type { Run } from "../output.js";

type Row = Record<string, unknown>;

// List endpoints exported as-is, keyed by output file name.
const LIST_RESOURCES: Record<string, string> = {
  "plans.json": "/plans", // includes add-ons (plan_type: "add_on") and each plan's versions
  "features.json": "/features",
  "flags.json": "/flags",
  "company-overrides.json": "/company-overrides",
  "companies.json": "/companies",
  "users.json": "/users",
  "credits.json": "/billing/credits",
  "credit-bundles.json": "/billing/credits/bundles",
  "plan-credit-grants.json": "/billing/credits/plan-grants",
  "credit-grants.json": "/billing/credits/grants/list",
  "plan-traits.json": "/plan-traits",
  "billing-products.json": "/billing/products",
  "billing-meters.json": "/billing/meter",
  "trait-definitions.json": "/entity-trait-definitions",
  "key-definitions.json": "/entity-key-definitions",
  "components.json": "/components",
  "webhooks.json": "/webhooks",
};

export async function exportConfig(api: ApiClient, run: Run, log: (msg: string) => void): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const results: Record<string, Row[]> = {};

  for (const [file, path] of Object.entries(LIST_RESOURCES)) {
    log(`config: ${path}`);
    let rows = await api.listAll<Row>(path);
    if (file === "webhooks.json") rows = rows.map(({ secret: _secret, ...rest }) => rest);
    results[file] = rows;
    await run.writeJson(`config/${file}`, rows);
    counts[file] = rows.length;
  }

  // Plan groups is a single settings object (default, fallback, and trial plans).
  log("config: /plan-groups");
  await run.writeJson("config/plan-groups.json", await api.get("/plan-groups"));

  // Entitlements differ between plan versions, and companies can sit on an
  // older version, so export the entitlements of every version.
  const versions: Row[] = [];
  for (const plan of results["plans.json"]) {
    for (const version of (plan.versions as Row[] | undefined) ?? []) {
      log(`config: entitlements for ${plan.id} v${version.version}`);
      const entitlements = await api.listAll<Row>("/plan-entitlements", { plan_version_id: String(version.id) });
      versions.push({
        plan_id: plan.id,
        plan_name: plan.name,
        plan_type: plan.plan_type,
        plan_version_id: version.id,
        version: version.version,
        status: version.status,
        entitlements,
      });
    }
  }
  await run.writeJson("config/plan-version-entitlements.json", versions);
  counts["plan-version-entitlements.json"] = versions.length;

  return counts;
}
