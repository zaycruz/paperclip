import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCostSyncPayload,
  buildBudgetAlertSignal,
  buildFleetUrl,
  buildLifecycleActionParams,
  buildOverviewStatus,
  buildRegisterExistingPayload,
  buildRepairPayload,
  buildScheduledCostSyncParams,
  clampHours,
  normalizeConfig,
  requireTenantId,
  summarizeOpsRollup,
  summarizeRoutineReconciliation,
} from "../src/logic.js";

test("normalizes connector config and clamps runtime windows", () => {
  const config = normalizeConfig({
    fleetApiBaseUrl: "https://fleet.example///",
    tenantIdByCompanyId: { "company-1": "tenant-1", empty: "" },
    enableRepairActions: "false",
    enableLifecycleActions: "true",
    lifecycleRequireApprovalRef: "false",
    enableBudgetAlerts: "true",
    budgetAlertUtilizationPercent: 999,
    enableScheduledCostSync: "true",
    scheduledCostSyncApply: "true",
    scheduledCostSyncHours: 9999,
  });
  assert.equal(config.fleetApiBaseUrl, "https://fleet.example");
  assert.deepEqual(config.tenantIdByCompanyId, { "company-1": "tenant-1" });
  assert.equal(config.enableRepairActions, false);
  assert.equal(config.enableLifecycleActions, true);
  assert.equal(config.lifecycleRequireApprovalRef, false);
  assert.equal(config.enableBudgetAlerts, true);
  assert.equal(config.budgetAlertUtilizationPercent, 100);
  assert.equal(config.enableScheduledCostSync, true);
  assert.equal(config.scheduledCostSyncApply, true);
  assert.equal(config.scheduledCostSyncHours, 720);
  assert.equal(clampHours(0), 1);
  assert.equal(clampHours(9999), 720);
});

test("builds Fleet API URLs without duplicating /api", () => {
  assert.equal(
    buildFleetUrl(
      { fleetApiBaseUrl: "https://fleet.example/api" },
      "/api/paperclip/companies/tenant-1/ops-rollup",
      { hours: 12 },
    ),
    "https://fleet.example/api/paperclip/companies/tenant-1/ops-rollup?hours=12",
  );
});

test("requires explicit company tenant mapping or fallback tenant", () => {
  assert.equal(
    requireTenantId("company-1", { tenantIdByCompanyId: { "company-1": "tenant-1" } }),
    "tenant-1",
  );
  assert.equal(requireTenantId("anything", { defaultTenantId: "tenant-default" }), "tenant-default");
  assert.throws(() => requireTenantId("missing", {}), /No Monolith tenant mapping/);
});

test("maps plugin action params into Monolith REST payloads", () => {
  assert.deepEqual(
    buildRegisterExistingPayload(
      {
        paperclipAgentId: "agent-1",
        agentRole: "quality-reviewer",
        reportsToContainerId: "boss-container",
        skills: ["quality", "", "routine"],
      },
      "tenant-1",
    ),
    {
      tenant_id: "tenant-1",
      paperclip_agent_id: "agent-1",
      agent_role: "quality-reviewer",
      reports_to_container_id: "boss-container",
      skills: ["quality", "routine"],
    },
  );
  assert.deepEqual(buildRepairPayload({ ip: "10.0.0.7" }), { ip: "10.0.0.7" });
  assert.deepEqual(buildCostSyncPayload({ dryRun: "false", hours: 48 }), {
    hours: 48,
    dry_run: false,
    force: false,
  });
  assert.deepEqual(
    buildScheduledCostSyncParams({ scheduledCostSyncApply: "true", scheduledCostSyncHours: 48 }),
    { hours: 48, dryRun: false },
  );
  assert.deepEqual(
    buildScheduledCostSyncParams({ scheduledCostSyncApply: "false", scheduledCostSyncHours: 9999 }),
    { hours: 720, dryRun: true },
  );
});

test("builds guarded lifecycle action params", () => {
  assert.deepEqual(
    buildLifecycleActionParams(
      { operation: "pause", approvalRef: "approval-1", reason: "budget hard stop" },
      { lifecycleRequireApprovalRef: true },
    ),
    { operation: "pause", approvalRef: "approval-1", reason: "budget hard stop" },
  );
  assert.deepEqual(
    buildLifecycleActionParams({ action: "resume" }, { lifecycleRequireApprovalRef: false }),
    { operation: "resume", approvalRef: "", reason: "" },
  );
  assert.throws(
    () => buildLifecycleActionParams({ operation: "restart" }, { lifecycleRequireApprovalRef: false }),
    /pause' or 'resume/,
  );
  assert.throws(
    () => buildLifecycleActionParams({ operation: "pause" }, { lifecycleRequireApprovalRef: true }),
    /approvalRef/,
  );
});

test("builds deduplicatable budget alert signals from rollup summaries", () => {
  assert.equal(
    buildBudgetAlertSignal(
      { budgetActiveIncidents: 0, pendingBudgetApprovals: 0, budgetMaxUtilizationPercent: 50 },
      { budgetAlertUtilizationPercent: 90 },
    ),
    null,
  );
  assert.equal(
    buildBudgetAlertSignal(
      { budgetActiveIncidents: 2, pendingBudgetApprovals: 1, budgetMaxUtilizationPercent: 97.255 },
      { enableBudgetAlerts: false },
    ),
    null,
  );
  assert.deepEqual(
    buildBudgetAlertSignal(
      { budgetActiveIncidents: 0, pendingBudgetApprovals: 2, budgetMaxUtilizationPercent: 93.456 },
      { budgetAlertUtilizationPercent: 90 },
    ),
    {
      severity: "warning",
      activeIncidents: 0,
      pendingApprovals: 2,
      maxUtilizationPercent: 93.46,
      thresholdPercent: 90,
      reasons: ["2 pending budget approvals", "93.46% max utilization"],
      fingerprint: "warning:0:2:93.46:90",
      message: "Fleet budget warning: 2 pending budget approvals, 93.46% max utilization",
    },
  );
  assert.equal(
    buildBudgetAlertSignal(
      { budgetActiveIncidents: 1, pendingBudgetApprovals: 0, budgetMaxUtilizationPercent: 10 },
      { budgetAlertUtilizationPercent: 90 },
    )?.severity,
    "critical",
  );
});

test("summarizes rollup and routine reconciliation into connector status", () => {
  const ops = summarizeOpsRollup({
    status: "active",
    summary: {
      linked_agents: 2,
      liveness: { active: 2 },
      cost: { message_count: 2, total_tokens: 150, total_cost: 0.025 },
      budget: { active_incident_count: 1, pending_approval_count: 1, max_utilization_percent: 90 },
    },
  });
  const routine = summarizeRoutineReconciliation({
    status: "drift",
    summary: { missing: 1, drift: 0, unmanaged: 0, runtime_errors: 0 },
  });
  assert.equal(ops.linkedAgents, 2);
  assert.equal(ops.budgetActiveIncidents, 1);
  assert.equal(ops.pendingBudgetApprovals, 1);
  assert.equal(routine.missing, 1);
  assert.equal(buildOverviewStatus(ops, routine), "drift");
});
