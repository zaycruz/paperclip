import assert from "node:assert/strict";
import test from "node:test";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import {
  ACTION_KEYS,
  DATA_KEYS,
  MANAGED_RESOURCE_KEYS,
  ROUTE_KEYS,
} from "../src/constants.js";

process.env.PAPERCLIP_PLUGIN_DISABLE_AUTORUN = "1";

test("registers scheduled job handlers exposed by the manifest", async () => {
  const { default: plugin } = await import("../src/worker.js");
  const harness = createTestHarness({
    manifest,
    config: {
      fleetApiBaseUrl: "https://fleet.example",
      tenantIdByCompanyId: { "company-1": "tenant-1" },
      enableScheduledCostSync: false,
    },
  });

  await plugin.definition.setup(harness.ctx);

  await harness.runJob("scheduled-cost-sync", {
    runId: "run-cost-sync",
    trigger: "schedule",
    scheduledAt: "2026-05-07T14:00:00.000Z",
  });
  await harness.runJob("poll-fleet-links", {
    runId: "run-poll",
    trigger: "schedule",
    scheduledAt: "2026-05-07T14:00:00.000Z",
  });

  const lastCostSync = harness.getState({
    scopeKind: "instance",
    namespace: "fleet-connector",
    stateKey: "last-cost-sync",
  });
  assert.match(lastCostSync.checkedAt, /\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(lastCostSync, {
    checkedAt: lastCostSync.checkedAt,
    runId: "run-cost-sync",
    trigger: "schedule",
    enabled: false,
    configuredCompanies: 1,
    failures: 0,
    results: [],
  });

  assert.equal(harness.metrics.some((metric) => metric.name === "fleet.cost_sync_job_runs"), true);
  assert.equal(
    harness.getState({
      scopeKind: "instance",
      namespace: "fleet-connector",
      stateKey: "last-poll",
    })?.runId,
    "run-poll",
  );
});

test("reconciles managed governance resources exposed by the manifest", async () => {
  const { default: plugin } = await import("../src/worker.js");
  const harness = createTestHarness({
    manifest,
    config: {
      fleetApiBaseUrl: "https://fleet.example",
      tenantIdByCompanyId: { "company-1": "tenant-1" },
    },
  });

  await plugin.definition.setup(harness.ctx);

  const reconciled = await harness.performAction(ACTION_KEYS.reconcileManagedResources, {
    companyId: "company-1",
  });

  assert.equal(reconciled.ready, true);
  assert.equal(reconciled.mode, "reconcile");
  assert.equal(reconciled.tenantId, "tenant-1");
  assert.equal(reconciled.resources.agent.resourceKey, MANAGED_RESOURCE_KEYS.agent);
  assert.equal(reconciled.resources.agent.status, "created");
  assert.equal(reconciled.resources.agent.agentStatus, "paused");
  assert.equal(reconciled.resources.project.resourceKey, MANAGED_RESOURCE_KEYS.project);
  assert.equal(reconciled.resources.project.status, "created");
  assert.equal(reconciled.resources.routine.resourceKey, MANAGED_RESOURCE_KEYS.routine);
  assert.equal(reconciled.resources.routine.status, "created");
  assert.equal(reconciled.resources.routine.routineStatus, "paused");

  const state = harness.getState({
    scopeKind: "company",
    scopeId: "company-1",
    namespace: "fleet-connector",
    stateKey: "managed-resources",
  });
  assert.equal(state.ready, true);
  assert.equal(harness.activity.some((entry) => entry.message.includes("Reconciled Fleet managed resources")), true);
  assert.equal(harness.metrics.some((metric) => metric.name === "fleet.managed_resources_reconcile"), true);

  const status = await harness.getData(DATA_KEYS.managedResources, { companyId: "company-1" });
  assert.equal(status.mode, "status");
  assert.equal(status.ready, true);
  assert.equal(status.resources.agent.status, "resolved");

  const routed = await plugin.definition.onApiRequest({
    routeKey: ROUTE_KEYS.reconcileManagedResources,
    body: { companyId: "company-1" },
    actor: { actorType: "user", actorId: "user-1" },
  });
  assert.equal(routed.body.ready, true);
  assert.equal(routed.body.resources.routine.status, "resolved");
});

test("rejects agent-scoped calls to mutating Fleet API routes", async () => {
  const { default: plugin } = await import("../src/worker.js");
  let fetchCalled = false;
  const harness = createTestHarness({
    manifest,
    config: {
      fleetApiBaseUrl: "https://fleet.example",
      tenantIdByCompanyId: { "company-1": "tenant-1" },
      enableCostSyncActions: true,
    },
  });
  harness.ctx.http.fetch = async () => {
    fetchCalled = true;
    throw new Error("fetch should not be called for agent-scoped mutation route");
  };

  await plugin.definition.setup(harness.ctx);
  const result = await plugin.definition.onApiRequest({
    routeKey: ROUTE_KEYS.syncCosts,
    body: { companyId: "company-1", apply: true, approvalRef: "RAA-468" },
    actor: { actorType: "agent", actorId: "agent-1", agentId: "agent-1" },
    companyId: "company-1",
  });

  assert.equal(result.status, 403);
  assert.match(result.body.error, /Board access required/);
  assert.equal(fetchCalled, false);
});

test("records budget alert activity from Fleet rollup state", async () => {
  const { default: plugin } = await import("../src/worker.js");
  const harness = createTestHarness({
    manifest,
    config: {
      fleetApiBaseUrl: "https://fleet.example",
      tenantIdByCompanyId: { "company-1": "tenant-1" },
      enableBudgetAlerts: true,
      budgetAlertUtilizationPercent: 90,
    },
  });
  harness.ctx.http.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes("/ops-rollup")) {
      return new Response(JSON.stringify({
        status: "active",
        summary: {
          linked_agents: 1,
          liveness: { active: 1 },
          cost: { message_count: 12, total_tokens: 345, total_cost: 1.25 },
          budget: {
            active_incident_count: 1,
            pending_approval_count: 2,
            max_utilization_percent: 96.4,
          },
        },
        agents: [{ container_id: "container-1", liveness_status: "active" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (requestUrl.includes("/routine-reconciliation")) {
      return new Response(JSON.stringify({
        matches: [],
        drift: [],
        missing_contracts: [],
        unmanaged_paperclip_routines: [],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected request: ${requestUrl}`);
  };

  await plugin.definition.setup(harness.ctx);
  const overview = await harness.getData(DATA_KEYS.overview, { companyId: "company-1" });

  assert.equal(overview.summary.budgetActiveIncidents, 1);
  assert.equal(harness.activity.some((entry) => entry.message.includes("Fleet budget critical")), true);
  assert.equal(harness.metrics.some((metric) => metric.name === "fleet.budget_alert_events"), true);
  assert.equal(harness.getState({
    scopeKind: "company",
    scopeId: "company-1",
    namespace: "fleet-connector",
    stateKey: "last-budget-alert",
  }).active, true);
});

test("runs cost sync dry-run without enabling apply and records operator evidence", async () => {
  const { default: plugin } = await import("../src/worker.js");
  const requests = [];
  const harness = createTestHarness({
    manifest,
    config: {
      fleetApiBaseUrl: "https://fleet.example",
      tenantIdByCompanyId: { "company-1": "tenant-1" },
      enableCostSyncActions: false,
    },
  });
  harness.ctx.http.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    assert.equal(String(url), "https://fleet.example/api/paperclip/companies/tenant-1/cost-sync");
    assert.deepEqual(JSON.parse(init.body), { hours: 24, dry_run: true, force: false });
    return new Response(JSON.stringify({ status: "planned" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await plugin.definition.setup(harness.ctx);
  const result = await harness.performAction(ACTION_KEYS.syncCosts, { companyId: "company-1" });

  assert.equal(result.status, "planned");
  assert.equal(requests.length, 1);
  assert.equal(harness.activity.some((entry) => entry.message.includes("Ran dry-run Fleet cost sync")), true);
  assert.equal(harness.metrics.some((metric) => metric.name === "fleet.cost_sync" && metric.tags.dry_run === "true"), true);
});

test("blocks cost sync apply without an approval reference", async () => {
  const { default: plugin } = await import("../src/worker.js");
  let fetchCalled = false;
  const harness = createTestHarness({
    manifest,
    config: {
      fleetApiBaseUrl: "https://fleet.example",
      tenantIdByCompanyId: { "company-1": "tenant-1" },
      enableCostSyncActions: true,
    },
  });
  harness.ctx.http.fetch = async () => {
    fetchCalled = true;
    throw new Error("fetch should not be called for blocked cost apply");
  };

  await plugin.definition.setup(harness.ctx);
  const result = await harness.performAction(ACTION_KEYS.syncCosts, {
    companyId: "company-1",
    apply: true,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.approvalRequired, true);
  assert.match(result.reason, /approvalRef or changeRequestId/);
  assert.equal(fetchCalled, false);
  assert.equal(harness.activity.some((entry) => entry.message.includes("Blocked Fleet cost-sync apply")), true);
  assert.equal(harness.metrics.some((metric) => metric.name === "fleet.guarded_mutation_requests" && metric.tags.status === "blocked"), true);
});

test("blocks repair link by default and requires approval when enabled", async () => {
  const { default: plugin } = await import("../src/worker.js");
  let fetchCalled = false;
  const harness = createTestHarness({
    manifest,
    config: {
      fleetApiBaseUrl: "https://fleet.example",
      tenantIdByCompanyId: { "company-1": "tenant-1" },
    },
  });
  harness.ctx.http.fetch = async () => {
    fetchCalled = true;
    throw new Error("fetch should not be called for disabled repair action");
  };

  await plugin.definition.setup(harness.ctx);
  const result = await harness.performAction(ACTION_KEYS.repairLink, {
    companyId: "company-1",
    containerId: "container-1",
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.approvalRequired, true);
  assert.match(result.reason, /disabled/);
  assert.equal(fetchCalled, false);
  assert.equal(harness.activity.some((entry) => entry.message.includes("Blocked Fleet repair-link request")), true);

  const enabledHarness = createTestHarness({
    manifest,
    config: {
      fleetApiBaseUrl: "https://fleet.example",
      tenantIdByCompanyId: { "company-1": "tenant-1" },
      enableRepairActions: true,
    },
  });
  enabledHarness.ctx.http.fetch = async () => {
    throw new Error("fetch should not be called for missing repair approval");
  };
  await plugin.definition.setup(enabledHarness.ctx);
  const missingApproval = await enabledHarness.performAction(ACTION_KEYS.repairLink, {
    companyId: "company-1",
    containerId: "container-1",
  });
  assert.equal(missingApproval.status, "blocked");
  assert.match(missingApproval.reason, /approvalRef or changeRequestId/);
});

test("runs routine repair dry-run and records operator evidence", async () => {
  const { default: plugin } = await import("../src/worker.js");
  const requests = [];
  const harness = createTestHarness({
    manifest,
    config: {
      fleetApiBaseUrl: "https://fleet.example",
      fleetApiTokenSecretRef: "00000000-0000-4000-8000-000000000001",
      tenantIdByCompanyId: { "company-1": "tenant-1" },
    },
  });
  harness.ctx.secrets.resolve = async (secretRef, options = {}) => {
    assert.equal(secretRef, "00000000-0000-4000-8000-000000000001");
    assert.equal(options.companyId, "company-1");
    return "fleet-test-token";
  };
  harness.ctx.http.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    assert.equal(String(url), "https://fleet.example/api/paperclip/companies/tenant-1/routine-repair");
    assert.equal(init.headers.authorization, "Bearer fleet-test-token");
    assert.deepEqual(JSON.parse(init.body), { dry_run: true, force: false });
    return new Response(JSON.stringify({
      status: "planned",
      summary: {
        planned_actions: 2,
        applied_actions: 0,
        skipped_actions: 0,
        failed_actions: 0,
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  await plugin.definition.setup(harness.ctx);
  const result = await harness.performAction(ACTION_KEYS.routineRepair, {
    companyId: "company-1",
    dryRun: true,
  });

  assert.equal(result.mode, "dry_run");
  assert.equal(result.tenantId, "tenant-1");
  assert.equal(result.result.status, "planned");
  assert.equal(requests.length, 1);
  assert.equal(harness.activity.some((entry) => entry.message.includes("Ran dry-run Fleet routine repair")), true);
  assert.equal(harness.metrics.some((metric) => metric.name === "fleet.routine_repair" && metric.tags.mode === "dry_run"), true);
});

test("blocks routine repair apply without an approval reference", async () => {
  const { default: plugin } = await import("../src/worker.js");
  let fetchCalled = false;
  const harness = createTestHarness({
    manifest,
    config: {
      fleetApiBaseUrl: "https://fleet.example",
      tenantIdByCompanyId: { "company-1": "tenant-1" },
      enableRoutineRepairActions: true,
      routineRepairRequireApprovalRef: true,
    },
  });
  harness.ctx.http.fetch = async () => {
    fetchCalled = true;
    throw new Error("fetch should not be called for blocked repair");
  };

  await plugin.definition.setup(harness.ctx);
  const result = await harness.performAction(ACTION_KEYS.routineRepair, {
    companyId: "company-1",
    apply: true,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.approvalRequired, true);
  assert.match(result.reason, /approvalRef or changeRequestId/);
  assert.equal(fetchCalled, false);
  assert.equal(harness.activity.some((entry) => entry.message.includes("Blocked Fleet routine repair")), true);
});

test("creates approval-bound Fleet Manager routine repair proposal", async () => {
  const { default: plugin } = await import("../src/worker.js");
  const requests = [];
  const harness = createTestHarness({
    manifest,
    config: {
      fleetApiBaseUrl: "https://api-staging.fleetos.raavasolutions.com",
      tenantIdByCompanyId: { "company-1": "tenant-1" },
      enableRoutineRepairActions: true,
      routineRepairRequireApprovalRef: true,
    },
  });
  harness.ctx.http.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    assert.equal(String(url), "https://api-staging.fleetos.raavasolutions.com/api/fleet-manager/actions");
    const body = JSON.parse(init.body);
    assert.equal(body.tenant_id, "tenant-1");
    assert.equal(body.action_type, "paperclip.routine_repair");
    assert.equal(body.tool_name, "paperclip_routine_repair");
    assert.equal(body.risk_class, "operational_write");
    assert.equal(body.target_environment, "staging");
    assert.equal(body.payload.approval_ref, "RAA-467");
    assert.equal(body.payload.contracts_path, "/home/agent/.hermes/routine-contracts.yaml");
    return new Response(JSON.stringify({
      id: "fmact_test",
      status: "pending_approval",
      approval_required: true,
      tool_name: "paperclip_routine_repair",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  await plugin.definition.setup(harness.ctx);
  const result = await harness.performAction(ACTION_KEYS.routineRepair, {
    companyId: "company-1",
    apply: true,
    approvalRef: "RAA-467",
  });

  assert.equal(result.mode, "approval_request");
  assert.equal(result.approvalRequired, true);
  assert.equal(result.result.id, "fmact_test");
  assert.equal(requests.length, 1);
  assert.equal(harness.activity.some((entry) => entry.message.includes("Requested approval-bound Fleet routine repair")), true);
});

test("records failed routine repair attempts", async () => {
  const { default: plugin } = await import("../src/worker.js");
  const harness = createTestHarness({
    manifest,
    config: {
      fleetApiBaseUrl: "https://fleet.example",
      tenantIdByCompanyId: { "company-1": "tenant-1" },
    },
  });
  harness.ctx.http.fetch = async () => new Response(JSON.stringify({ error: "Fleet unavailable" }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });

  await plugin.definition.setup(harness.ctx);
  await assert.rejects(
    () => harness.performAction(ACTION_KEYS.routineRepair, { companyId: "company-1", dryRun: true }),
    /Fleet unavailable/,
  );
  assert.equal(harness.activity.some((entry) => entry.message.includes("Fleet routine repair failed")), true);
  assert.equal(harness.metrics.some((metric) => metric.name === "fleet.routine_repair" && metric.tags.status === "failed"), true);
});

test("redacts upstream Fleet API auth echoes from errors and activity", async () => {
  const { default: plugin } = await import("../src/worker.js");
  const harness = createTestHarness({
    manifest,
    config: {
      fleetApiBaseUrl: "https://fleet.example",
      fleetApiTokenSecretRef: "00000000-0000-4000-8000-000000000001",
      tenantIdByCompanyId: { "company-1": "tenant-1" },
    },
  });
  harness.ctx.secrets.resolve = async () => "raw-secret-token";
  harness.ctx.http.fetch = async () => new Response(JSON.stringify({
    error: "upstream rejected Authorization: Bearer raw-secret-token",
  }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });

  await plugin.definition.setup(harness.ctx);
  await assert.rejects(
    () => harness.performAction(ACTION_KEYS.routineRepair, { companyId: "company-1", dryRun: true }),
    (error) => {
      assert.equal(String(error.message).includes("raw-secret-token"), false);
      assert.match(error.message, /Bearer \[REDACTED\]/);
      return true;
    },
  );
  assert.equal(JSON.stringify(harness.activity).includes("raw-secret-token"), false);
});

test("blocks lifecycle apply without an approval reference and records operator evidence", async () => {
  const { default: plugin } = await import("../src/worker.js");
  let fetchCalled = false;
  const harness = createTestHarness({
    manifest,
    config: {
      fleetApiBaseUrl: "https://fleet.example",
      tenantIdByCompanyId: { "company-1": "tenant-1" },
      enableLifecycleActions: true,
      lifecycleRequireApprovalRef: true,
    },
  });
  harness.ctx.http.fetch = async () => {
    fetchCalled = true;
    throw new Error("fetch should not be called for blocked lifecycle request");
  };

  await plugin.definition.setup(harness.ctx);
  const result = await harness.performAction(ACTION_KEYS.lifecycle, {
    companyId: "company-1",
    containerId: "container-1",
    operation: "pause",
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.approvalRequired, true);
  assert.match(result.reason, /approvalRef or changeRequestId/);
  assert.equal(fetchCalled, false);
  assert.equal(harness.activity.some((entry) => entry.message.includes("Blocked Fleet lifecycle pause")), true);
  assert.equal(harness.metrics.some((metric) => metric.name === "fleet.lifecycle_requests" && metric.tags.status === "blocked"), true);
});

test("records approval-backed lifecycle requests", async () => {
  const { default: plugin } = await import("../src/worker.js");
  const requests = [];
  const harness = createTestHarness({
    manifest,
    config: {
      fleetApiBaseUrl: "https://fleet.example",
      tenantIdByCompanyId: { "company-1": "tenant-1" },
      enableLifecycleActions: true,
      lifecycleRequireApprovalRef: true,
    },
  });
  harness.ctx.http.fetch = async (url, init = {}) => {
    const requestUrl = String(url);
    requests.push({ url: requestUrl, init });
    if (requestUrl.includes("/ops-rollup")) {
      return new Response(JSON.stringify({
        status: "active",
        summary: { linked_agents: 1, liveness: { active: 1 }, cost: {}, budget: {} },
        agents: [{ container_id: "container-1", paperclip_agent_id: "agent-1", liveness_status: "active" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (requestUrl.includes("/routine-reconciliation")) {
      return new Response(JSON.stringify({
        matches: [],
        drift: [],
        missing_contracts: [],
        unmanaged_paperclip_routines: [],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (requestUrl === "https://fleet.example/api/containers/container-1/pause?async=true") {
      return new Response(JSON.stringify({ operation_id: "op-1", status: "queued" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected request: ${requestUrl}`);
  };

  await plugin.definition.setup(harness.ctx);
  const result = await harness.performAction(ACTION_KEYS.lifecycle, {
    companyId: "company-1",
    containerId: "container-1",
    operation: "pause",
    approvalRef: "approval-1",
    reason: "budget hard stop",
  });

  assert.equal(result.operation, "pause");
  assert.equal(result.approvalRef, "approval-1");
  assert.equal(result.result.operation_id, "op-1");
  assert.equal(requests.some((request) => request.url.endsWith("/pause?async=true")), true);
  assert.equal(harness.activity.some((entry) => entry.message.includes("Requested Fleet pause")), true);
  assert.equal(harness.metrics.some((metric) => metric.name === "fleet.lifecycle_requests" && metric.tags.status === "requested"), true);
});

test("records failed lifecycle requests", async () => {
  const { default: plugin } = await import("../src/worker.js");
  const harness = createTestHarness({
    manifest,
    config: {
      fleetApiBaseUrl: "https://fleet.example",
      tenantIdByCompanyId: { "company-1": "tenant-1" },
      enableLifecycleActions: true,
      lifecycleRequireApprovalRef: true,
    },
  });
  harness.ctx.http.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes("/ops-rollup")) {
      return new Response(JSON.stringify({
        status: "active",
        summary: { linked_agents: 1, liveness: { active: 1 }, cost: {}, budget: {} },
        agents: [{ container_id: "container-1", paperclip_agent_id: "agent-1", liveness_status: "active" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (requestUrl.includes("/routine-reconciliation")) {
      return new Response(JSON.stringify({
        matches: [],
        drift: [],
        missing_contracts: [],
        unmanaged_paperclip_routines: [],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (requestUrl.endsWith("/resume?async=true")) {
      return new Response(JSON.stringify({ error: "lifecycle queue unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected request: ${requestUrl}`);
  };

  await plugin.definition.setup(harness.ctx);
  await assert.rejects(
    () => harness.performAction(ACTION_KEYS.lifecycle, {
      companyId: "company-1",
      containerId: "container-1",
      operation: "resume",
      approvalRef: "approval-1",
    }),
    /lifecycle queue unavailable/,
  );

  assert.equal(harness.activity.some((entry) => entry.message.includes("Fleet lifecycle resume failed")), true);
  assert.equal(harness.metrics.some((metric) => metric.name === "fleet.lifecycle_requests" && metric.tags.status === "failed"), true);
});
