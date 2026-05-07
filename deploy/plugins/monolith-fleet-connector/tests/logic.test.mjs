import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCostSyncPayload,
  buildFleetUrl,
  buildOverviewStatus,
  buildRegisterExistingPayload,
  buildRepairPayload,
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
  });
  assert.equal(config.fleetApiBaseUrl, "https://fleet.example");
  assert.deepEqual(config.tenantIdByCompanyId, { "company-1": "tenant-1" });
  assert.equal(config.enableRepairActions, false);
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
