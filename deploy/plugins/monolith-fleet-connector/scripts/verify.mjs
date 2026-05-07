import assert from "node:assert/strict";
import manifest from "../src/manifest.js";
import {
  buildBudgetAlertSignal,
  buildCostSyncPayload,
  buildFleetUrl,
  buildLifecycleActionParams,
  buildRegisterExistingPayload,
  buildRepairPayload,
  buildScheduledCostSyncParams,
  normalizeConfig,
  redactConfig,
  resolveTenantId,
  summarizeOpsRollup,
  summarizeRoutineReconciliation,
} from "../src/logic.js";

const supportedCapabilities = new Set([
  "companies.read",
  "agents.read",
  "activity.log.write",
  "metrics.write",
  "plugin.state.read",
  "plugin.state.write",
  "jobs.schedule",
  "api.routes.register",
  "http.outbound",
  "secrets.read-ref",
  "instance.settings.register",
  "ui.sidebar.register",
  "ui.page.register",
  "ui.detailTab.register",
  "ui.dashboardWidget.register",
  "ui.action.register",
]);

assert.equal(manifest.id, "raava.monolith-fleet-connector");
assert.equal(manifest.apiVersion, 1);
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
for (const capability of manifest.capabilities) {
  assert.ok(supportedCapabilities.has(capability), `unexpected capability ${capability}`);
}
assert.equal(manifest.apiRoutes.length, 5);
assert.ok(manifest.apiRoutes.every((route) => route.capability === "api.routes.register"));
assert.ok(manifest.ui.slots.some((slot) => slot.type === "dashboardWidget"));
assert.ok(manifest.ui.slots.some((slot) => slot.type === "detailTab" && slot.entityTypes.includes("agent")));
const pageSlot = manifest.ui.slots.find((slot) => slot.type === "page");
assert.ok(pageSlot, "page slot is required");
assert.match(pageSlot.routePath, /^[a-z0-9-]+$/, "page routePath must be a lowercase single-segment slug");
assert.ok(manifest.jobs.some((job) => job.jobKey === "poll-fleet-links"));
assert.ok(manifest.jobs.some((job) => job.jobKey === "scheduled-cost-sync"));
assert.equal(manifest.instanceConfigSchema.properties.fleetApiTokenSecretRef.format, "secret-ref");
assert.equal(manifest.instanceConfigSchema.properties.enableBudgetAlerts.default, true);
assert.equal(manifest.instanceConfigSchema.properties.budgetAlertUtilizationPercent.maximum, 100);

const config = normalizeConfig({
  fleetApiBaseUrl: "https://fleet.example/api/",
  fleetApiTokenSecretRef: "secret://fleet-token",
  tenantIdByCompanyId: { "pc-co": "tenant-a", blank: " " },
  enableRegisterActions: "true",
  enableLifecycleActions: "true",
  budgetAlertUtilizationPercent: 95,
  enableScheduledCostSync: "true",
  scheduledCostSyncHours: 48,
});
assert.equal(config.fleetApiBaseUrl, "https://fleet.example/api");
assert.equal(resolveTenantId("pc-co", config), "tenant-a");
assert.equal(buildFleetUrl(config, "/api/paperclip/companies/tenant-a", { hours: 12 }), "https://fleet.example/api/paperclip/companies/tenant-a?hours=12");
assert.deepEqual(redactConfig(config), {
  fleetApiBaseUrl: "https://fleet.example/api",
  fleetApiTokenSecretRefConfigured: true,
  configuredCompanyIds: ["pc-co"],
  defaultTenantConfigured: false,
  enableRegisterActions: true,
  enableRepairActions: true,
  enableCostSyncActions: false,
  enableLifecycleActions: true,
  lifecycleRequireApprovalRef: true,
  enableBudgetAlerts: true,
  budgetAlertUtilizationPercent: 95,
  enableScheduledCostSync: true,
  scheduledCostSyncApply: false,
  scheduledCostSyncHours: 48,
});

assert.deepEqual(
  buildRegisterExistingPayload(
    {
      paperclipAgentId: "agent-1",
      agentName: "Aurum",
      skills: "quality,routine",
      gatewaySecret: "not-redacted-in-payload",
    },
    "tenant-a",
  ),
  {
    tenant_id: "tenant-a",
    paperclip_agent_id: "agent-1",
    agent_name: "Aurum",
    gateway_secret: "not-redacted-in-payload",
    skills: ["quality", "routine"],
  },
);
assert.deepEqual(buildRepairPayload({ adapterUrl: "https://adapter", provisionJobId: "job-1" }), {
  adapter_url: "https://adapter",
  provision_job_id: "job-1",
});
assert.deepEqual(
  buildLifecycleActionParams({ operation: "pause", changeRequestId: "cr-1", reason: "budget hard stop" }, config),
  { operation: "pause", approvalRef: "cr-1", reason: "budget hard stop" },
);
assert.deepEqual(buildCostSyncPayload({ apply: true, hours: 9999, force: "true" }), {
  hours: 720,
  dry_run: false,
  force: true,
});
assert.deepEqual(buildScheduledCostSyncParams(config), { hours: 48, dryRun: true });
assert.deepEqual(buildBudgetAlertSignal({
  budgetActiveIncidents: 1,
  pendingBudgetApprovals: 2,
  budgetMaxUtilizationPercent: 99.8,
}, config), {
  severity: "critical",
  activeIncidents: 1,
  pendingApprovals: 2,
  maxUtilizationPercent: 99.8,
  thresholdPercent: 95,
  reasons: ["1 active budget incident", "2 pending budget approvals", "99.8% max utilization"],
  fingerprint: "critical:1:2:99.8:95",
  message: "Fleet budget critical: 1 active budget incident, 2 pending budget approvals, 99.8% max utilization",
});

assert.deepEqual(
  summarizeOpsRollup({
    status: "degraded",
    summary: {
      linked_agents: 2,
      liveness: { active: 1 },
      cost: { message_count: 3, total_tokens: 99, total_cost: 0.25 },
      budget: { active_incident_count: 1, pending_approval_count: 2, max_utilization_percent: 91.25 },
      routine_contract_candidates: 1,
    },
    agents: [{ liveness_status: "active" }, { liveness_status: "degraded" }],
    recommendations: ["repair"],
  }),
  {
    status: "degraded",
    linkedAgents: 2,
    activeAgents: 1,
    degradedAgents: 1,
    messageCount: 3,
    totalTokens: 99,
    totalCost: 0.25,
    budgetActiveIncidents: 1,
    pendingBudgetApprovals: 2,
    budgetMaxUtilizationPercent: 91.25,
    routineCandidates: 1,
    recommendations: ["repair"],
  },
);
assert.equal(summarizeRoutineReconciliation({ status: "drift", summary: { missing: 1, drift: 2, unmanaged: 3, runtime_errors: 4 } }).runtimeErrors, 4);

console.log("paperclip-fleet-connector manifest and logic verified");
