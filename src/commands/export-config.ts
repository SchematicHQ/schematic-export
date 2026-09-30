// Exports plan configuration and account data as JSON: everything you would
// need to rebuild your pricing and entitlements somewhere else.

import { type Api, listAll, REQUEST_OPTIONS as opts } from "../api.js";
import type { Run } from "../output.js";

export async function exportConfig(api: Api, run: Run, log: (msg: string) => void): Promise<Record<string, number>> {
  const { client } = api;
  const counts: Record<string, number> = {};

  const write = async <T>(file: string, rows: T[]): Promise<T[]> => {
    log(`config: ${file}`);
    await run.writeJson(`config/${file}`, rows);
    counts[file] = rows.length;
    return rows;
  };

  // Plans include add-ons (planType: "add_on") and each plan's versions.
  const plans = await write("plans.json", await listAll((p) => client.plans.listPlans(p, opts)));
  await write("features.json", await listAll((p) => client.features.listFeatures(p, opts)));
  await write("flags.json", await listAll((p) => client.features.listFlags(p, opts)));
  await write("company-overrides.json", await listAll((p) => client.entitlements.listCompanyOverrides(p, opts)));
  await write("companies.json", await listAll((p) => client.companies.listCompanies(p, opts)));
  await write("users.json", await listAll((p) => client.companies.listUsers(p, opts)));
  await write("credits.json", await listAll((p) => client.credits.listBillingCredits(p, opts)));
  await write("credit-bundles.json", await listAll((p) => client.credits.listCreditBundles(p, opts)));
  await write("plan-credit-grants.json", await listAll((p) => client.credits.listBillingPlanCreditGrants(p, opts)));
  await write("credit-grants.json", await listAll((p) => client.credits.listGrantsForCredit(p, opts)));
  await write("plan-traits.json", await listAll((p) => client.companies.listPlanTraits(p, opts)));
  await write("billing-products.json", await listAll((p) => client.billing.listBillingProducts(p, opts)));
  await write("billing-meters.json", await listAll((p) => client.billing.listMeters(p, opts)));
  await write("trait-definitions.json", await listAll((p) => client.companies.listEntityTraitDefinitions(p, opts)));
  await write("key-definitions.json", await listAll((p) => client.companies.listEntityKeyDefinitions(p, opts)));
  await write("components.json", await listAll((p) => client.components.listComponents(p, opts)));

  // Webhook signing secrets stay out of the export.
  const webhooks = await listAll((p) => client.webhooks.listWebhooks(p, opts));
  await write("webhooks.json", webhooks.map(({ secret: _secret, ...rest }) => rest));

  // Plan groups is a single settings object (default, fallback, and trial plans).
  log("config: plan-groups.json");
  await run.writeJson("config/plan-groups.json", (await client.plangroups.getPlanGroup({}, opts)).data);

  // Entitlements differ between plan versions, and companies can sit on an
  // older version, so export the entitlements of every version.
  const versions = [];
  for (const plan of plans) {
    for (const version of plan.versions ?? []) {
      log(`config: entitlements for ${plan.id} v${version.version}`);
      versions.push({
        planId: plan.id,
        planName: plan.name,
        planType: plan.planType,
        planVersionId: version.id,
        version: version.version,
        status: version.status,
        entitlements: await listAll((p) =>
          client.entitlements.listPlanEntitlements({ ...p, planVersionId: version.id }, opts),
        ),
      });
    }
  }
  await write("plan-version-entitlements.json", versions);

  return counts;
}
