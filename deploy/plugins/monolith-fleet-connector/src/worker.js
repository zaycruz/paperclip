import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import {
  ACTION_KEYS,
  DATA_KEYS,
  JOB_KEYS,
  PLUGIN_ID,
  ROUTE_KEYS,
  STATE_NAMESPACE,
} from "./constants.js";
import {
  authorizationHeaders,
  buildBudgetAlertSignal,
  buildCostSyncPayload,
  buildFleetUrl,
  buildLifecycleActionParams,
  buildOverviewStatus,
  buildRegisterExistingPayload,
  buildRepairPayload,
  buildScheduledCostSyncParams,
  clampHours,
  normalizeConfig,
  redactConfig,
  requireTenantId,
  summarizeOpsRollup,
  summarizeRoutineReconciliation,
} from "./logic.js";

let currentContext = null;

function stringField(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function companyStateKey(companyId) {
  return {
    scopeKind: "company",
    scopeId: companyId,
    namespace: STATE_NAMESPACE,
    stateKey: "last-overview",
  };
}

function budgetAlertStateKey(companyId) {
  return {
    scopeKind: "company",
    scopeId: companyId,
    namespace: STATE_NAMESPACE,
    stateKey: "last-budget-alert",
  };
}

async function getConfig(ctx) {
  return normalizeConfig(await ctx.config.get());
}

async function resolveFleetToken(ctx, config) {
  if (!config.fleetApiTokenSecretRef) return "";
  const resolved = await ctx.secrets.resolve(config.fleetApiTokenSecretRef);
  if (typeof resolved === "string") return resolved;
  if (resolved && typeof resolved === "object") {
    return stringField(resolved.value) || stringField(resolved.secret) || stringField(resolved.token);
  }
  return "";
}

async function fleetRequest(ctx, config, path, options = {}) {
  const method = options.method || "GET";
  const token = await resolveFleetToken(ctx, config);
  const headers = authorizationHeaders(token, options.body ? { "content-type": "application/json" } : {});
  const response = await ctx.http.fetch(buildFleetUrl(config, path, options.query), {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let body = null;
  if (text.trim().length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  if (!response.ok) {
    const detail = body?.error || body?.detail || text.slice(0, 240);
    throw new Error(`Fleet API ${method} ${path} failed with ${response.status}: ${detail}`);
  }
  return body;
}

async function writeFleetMetrics(ctx, tenantId, overview, config) {
  const labels = {
    tenant_id: tenantId,
    status: overview.status,
  };
  const budgetAlert = buildBudgetAlertSignal(overview.summary, config);
  await ctx.metrics.write("fleet.linked_agents", overview.summary.linkedAgents, labels);
  await ctx.metrics.write("fleet.degraded_agents", overview.summary.degradedAgents, labels);
  await ctx.metrics.write("fleet.routine_drift_items", overview.routineSummary.missing + overview.routineSummary.drift + overview.routineSummary.unmanaged, labels);
  await ctx.metrics.write("fleet.total_cost", overview.summary.totalCost, labels);
  await ctx.metrics.write("fleet.budget_active_incidents", overview.summary.budgetActiveIncidents, labels);
  await ctx.metrics.write("fleet.budget_pending_approvals", overview.summary.pendingBudgetApprovals, labels);
  await ctx.metrics.write("fleet.budget_max_utilization_percent", overview.summary.budgetMaxUtilizationPercent, labels);
  await ctx.metrics.write("fleet.budget_alert_active", budgetAlert ? 1 : 0, {
    ...labels,
    severity: budgetAlert?.severity || "none",
  });
}

async function writeBudgetAlert(ctx, companyId, tenantId, overview, config) {
  const alert = buildBudgetAlertSignal(overview.summary, config);
  const key = budgetAlertStateKey(companyId);
  const previous = await ctx.state.get(key);
  const checkedAt = new Date().toISOString();

  if (!alert) {
    if (previous?.active) {
      await ctx.activity.log({
        companyId,
        message: `Fleet budget alert cleared for tenant ${tenantId}`,
        metadata: {
          plugin: PLUGIN_ID,
          tenantId,
          previousSeverity: previous.severity,
          previousFingerprint: previous.fingerprint,
        },
      });
    }
    await ctx.state.set(key, {
      checkedAt,
      tenantId,
      active: false,
      fingerprint: "",
    });
    return null;
  }

  const state = {
    ...alert,
    checkedAt,
    tenantId,
    active: true,
  };
  await ctx.state.set(key, state);
  if (previous?.fingerprint !== alert.fingerprint) {
    await ctx.activity.log({
      companyId,
      message: alert.message,
      metadata: {
        plugin: PLUGIN_ID,
        tenantId,
        severity: alert.severity,
        activeIncidents: alert.activeIncidents,
        pendingApprovals: alert.pendingApprovals,
        maxUtilizationPercent: alert.maxUtilizationPercent,
        thresholdPercent: alert.thresholdPercent,
        reasons: alert.reasons,
      },
    });
    await ctx.metrics.write("fleet.budget_alert_events", 1, {
      tenant_id: tenantId,
      severity: alert.severity,
    });
  }
  return state;
}

async function loadOverview(ctx, companyId, options = {}) {
  const config = await getConfig(ctx);
  const tenantId = requireTenantId(companyId, config);
  const hours = clampHours(options.hours, 24);
  const rollup = await fleetRequest(
    ctx,
    config,
    `/api/paperclip/companies/${encodeURIComponent(tenantId)}/ops-rollup`,
    { query: { hours } },
  );
  let routine = null;
  let routineError = null;
  try {
    routine = await fleetRequest(
      ctx,
      config,
      `/api/paperclip/companies/${encodeURIComponent(tenantId)}/routine-reconciliation`,
      { query: options.contractsPath ? { contracts_path: options.contractsPath } : {} },
    );
  } catch (error) {
    routineError = errorMessage(error);
  }

  const summary = summarizeOpsRollup(rollup);
  const routineSummary = summarizeRoutineReconciliation(routine);
  const overview = {
    companyId,
    tenantId,
    checkedAt: new Date().toISOString(),
    hours,
    status: buildOverviewStatus(summary, routineSummary),
    summary,
    routineSummary,
    routineError,
    rollup,
    routine,
  };

  await ctx.state.set(companyStateKey(companyId), overview);
  await writeFleetMetrics(ctx, tenantId, overview, config);
  await writeBudgetAlert(ctx, companyId, tenantId, overview, config);
  return overview;
}

async function registerExistingAgent(ctx, params = {}) {
  const companyId = stringField(params.companyId);
  const containerId = stringField(params.containerId);
  if (!companyId || !containerId) {
    throw new Error("companyId and containerId are required");
  }
  const config = await getConfig(ctx);
  if (!config.enableRegisterActions) {
    throw new Error("Register existing agent actions are disabled in plugin settings");
  }
  const tenantId = requireTenantId(companyId, config);
  const payload = buildRegisterExistingPayload(params, tenantId);
  const result = await fleetRequest(
    ctx,
    config,
    `/api/paperclip/agents/${encodeURIComponent(containerId)}/register-existing`,
    { method: "POST", body: payload },
  );
  await ctx.activity.log({
    companyId,
    entityType: "agent",
    entityId: stringField(params.paperclipAgentId) || stringField(params.paperclip_agent_id) || undefined,
    message: `Registered Fleet agent ${containerId} through Monolith Fleet Connector`,
    metadata: { plugin: PLUGIN_ID, containerId, tenantId },
  });
  await ctx.metrics.write("fleet.register_existing", 1, { tenant_id: tenantId });
  return result;
}

async function repairAgentLink(ctx, params = {}) {
  const companyId = stringField(params.companyId);
  const containerId = stringField(params.containerId);
  if (!companyId || !containerId) {
    throw new Error("companyId and containerId are required");
  }
  const config = await getConfig(ctx);
  if (!config.enableRepairActions) {
    throw new Error("Repair actions are disabled in plugin settings");
  }
  const tenantId = requireTenantId(companyId, config);
  const result = await fleetRequest(
    ctx,
    config,
    `/api/paperclip/agents/${encodeURIComponent(containerId)}/repair`,
    { method: "POST", body: buildRepairPayload(params) },
  );
  await ctx.activity.log({
    companyId,
    entityType: "agent",
    entityId: stringField(params.paperclipAgentId) || stringField(params.paperclip_agent_id) || undefined,
    message: `Repaired Fleet link for ${containerId} through Monolith Fleet Connector`,
    metadata: { plugin: PLUGIN_ID, containerId, tenantId },
  });
  await ctx.metrics.write("fleet.repair_link", 1, { tenant_id: tenantId });
  return result;
}

async function syncCosts(ctx, params = {}) {
  const companyId = stringField(params.companyId);
  if (!companyId) {
    throw new Error("companyId is required");
  }
  const config = await getConfig(ctx);
  const payload = buildCostSyncPayload(params);
  if (!payload.dry_run && !config.enableCostSyncActions) {
    throw new Error("Cost sync apply is disabled in plugin settings");
  }
  const tenantId = requireTenantId(companyId, config);
  const result = await fleetRequest(
    ctx,
    config,
    `/api/paperclip/companies/${encodeURIComponent(tenantId)}/cost-sync`,
    { method: "POST", body: payload },
  );
  await ctx.activity.log({
    companyId,
    message: payload.dry_run
      ? `Ran dry-run Fleet cost sync for tenant ${tenantId}`
      : `Applied Fleet cost sync for tenant ${tenantId}`,
    metadata: { plugin: PLUGIN_ID, tenantId, dryRun: payload.dry_run },
  });
  await ctx.metrics.write("fleet.cost_sync", 1, {
    tenant_id: tenantId,
    dry_run: String(payload.dry_run),
  });
  return result;
}

async function requestLifecycle(ctx, params = {}) {
  const companyId = stringField(params.companyId);
  const containerId = stringField(params.containerId);
  if (!companyId || !containerId) {
    throw new Error("companyId and containerId are required");
  }

  const config = await getConfig(ctx);
  if (!config.enableLifecycleActions) {
    throw new Error("Lifecycle actions are disabled in plugin settings");
  }
  const tenantId = requireTenantId(companyId, config);
  const action = buildLifecycleActionParams(params, config);
  const overview = await loadOverview(ctx, companyId);
  const linkedAgent = Array.isArray(overview.rollup?.agents)
    ? overview.rollup.agents.find((agent) => agent?.container_id === containerId || agent?.containerId === containerId)
    : null;
  if (!linkedAgent) {
    throw new Error(`Container ${containerId} is not linked to Paperclip company ${companyId}`);
  }

  const result = await fleetRequest(
    ctx,
    config,
    `/api/containers/${encodeURIComponent(containerId)}/${action.operation}`,
    { method: "POST", query: { async: "true" } },
  );
  await ctx.activity.log({
    companyId,
    entityType: "agent",
    entityId: linkedAgent.paperclip_agent_id || linkedAgent.paperclipAgentId || undefined,
    message: `Requested Fleet ${action.operation} for ${containerId} through Monolith Fleet Connector`,
    metadata: {
      plugin: PLUGIN_ID,
      containerId,
      tenantId,
      operation: action.operation,
      approvalRef: action.approvalRef,
      reason: action.reason,
      fleetOperationId: result?.operation_id,
    },
  });
  await ctx.metrics.write("fleet.lifecycle_requests", 1, {
    tenant_id: tenantId,
    operation: action.operation,
  });
  return {
    operation: action.operation,
    approvalRef: action.approvalRef,
    containerId,
    tenantId,
    result,
  };
}

async function runScheduledCostSync(ctx, job = {}) {
  const config = await getConfig(ctx);
  const companyIds = Object.keys(config.tenantIdByCompanyId);
  const scheduledParams = buildScheduledCostSyncParams(config);
  const results = [];

  if (!config.enableScheduledCostSync) {
    const jobState = {
      checkedAt: new Date().toISOString(),
      runId: job.runId,
      trigger: job.trigger,
      enabled: false,
      configuredCompanies: companyIds.length,
      failures: 0,
      results,
    };
    await ctx.state.set({ scopeKind: "instance", namespace: STATE_NAMESPACE, stateKey: "last-cost-sync" }, jobState);
    await ctx.metrics.write("fleet.cost_sync_job_runs", 1, {
      trigger: job.trigger,
      enabled: "false",
      apply: "false",
      failures: "0",
    });
    return jobState;
  }

  for (const companyId of companyIds) {
    try {
      results.push({
        companyId,
        status: "ok",
        result: await syncCosts(ctx, {
          companyId,
          ...scheduledParams,
        }),
      });
    } catch (error) {
      results.push({ companyId, status: "error", error: errorMessage(error) });
    }
  }

  const jobState = {
    checkedAt: new Date().toISOString(),
    runId: job.runId,
    trigger: job.trigger,
    enabled: true,
    dryRun: scheduledParams.dryRun,
    hours: scheduledParams.hours,
    configuredCompanies: companyIds.length,
    failures: results.filter((entry) => entry.status === "error").length,
    results,
  };
  await ctx.state.set({ scopeKind: "instance", namespace: STATE_NAMESPACE, stateKey: "last-cost-sync" }, jobState);
  await ctx.metrics.write("fleet.cost_sync_job_runs", 1, {
    trigger: job.trigger,
    enabled: "true",
    apply: String(!scheduledParams.dryRun),
    failures: String(jobState.failures),
  });
  return jobState;
}

const plugin = definePlugin({
  async setup(ctx) {
    currentContext = ctx;
    ctx.data.register(DATA_KEYS.config, async () => redactConfig(await getConfig(ctx)));

    ctx.data.register(DATA_KEYS.overview, async (params) => {
      const companyId = stringField(params.companyId);
      if (!companyId) throw new Error("companyId is required");
      return loadOverview(ctx, companyId, {
        hours: params.hours,
        contractsPath: stringField(params.contractsPath) || stringField(params.contracts_path),
      });
    });

    ctx.data.register(DATA_KEYS.lastOverview, async (params) => {
      const companyId = stringField(params.companyId);
      if (!companyId) throw new Error("companyId is required");
      return await ctx.state.get(companyStateKey(companyId));
    });

    ctx.actions.register(ACTION_KEYS.refreshOverview, async (params) => {
      const companyId = stringField(params.companyId);
      if (!companyId) throw new Error("companyId is required");
      const overview = await loadOverview(ctx, companyId, {
        hours: params.hours,
        contractsPath: stringField(params.contractsPath) || stringField(params.contracts_path),
      });
      await ctx.activity.log({
        companyId,
        message: `Refreshed Fleet overview for tenant ${overview.tenantId}`,
        metadata: { plugin: PLUGIN_ID, tenantId: overview.tenantId, status: overview.status },
      });
      return overview;
    });

    ctx.actions.register(ACTION_KEYS.registerExisting, async (params) => registerExistingAgent(ctx, params));
    ctx.actions.register(ACTION_KEYS.repairLink, async (params) => repairAgentLink(ctx, params));
    ctx.actions.register(ACTION_KEYS.syncCosts, async (params) => syncCosts(ctx, params));
    ctx.actions.register(ACTION_KEYS.lifecycle, async (params) => requestLifecycle(ctx, params));

    ctx.jobs.register(JOB_KEYS.pollFleetLinks, async (job) => {
      const config = await getConfig(ctx);
      const companyIds = Object.keys(config.tenantIdByCompanyId);
      const results = [];
      for (const companyId of companyIds) {
        try {
          results.push({ companyId, status: "ok", overview: await loadOverview(ctx, companyId) });
        } catch (error) {
          results.push({ companyId, status: "error", error: errorMessage(error) });
        }
      }
      const jobState = {
        checkedAt: new Date().toISOString(),
        runId: job.runId,
        trigger: job.trigger,
        configuredCompanies: companyIds.length,
        failures: results.filter((entry) => entry.status === "error").length,
        results,
      };
      await ctx.state.set({ scopeKind: "instance", namespace: STATE_NAMESPACE, stateKey: "last-poll" }, jobState);
      await ctx.metrics.write("fleet.poll_runs", 1, {
        trigger: job.trigger,
        failures: String(jobState.failures),
      });
      return jobState;
    });

    ctx.jobs.register(JOB_KEYS.scheduledCostSync, async (job) => runScheduledCostSync(ctx, job));
  },

  async onApiRequest(input) {
    if (!currentContext) {
      return { status: 503, body: { error: "Fleet Connector worker setup has not completed" } };
    }
    const body = input.body && typeof input.body === "object" ? input.body : {};
    const query = input.query && typeof input.query === "object" ? input.query : {};
    const companyId = input.companyId || stringField(body.companyId) || stringField(query.companyId);

    if (input.routeKey === ROUTE_KEYS.overview) {
      return {
        body: await loadOverview(currentContext, companyId, { hours: query.hours }),
      };
    }
    if (input.routeKey === ROUTE_KEYS.registerExisting) {
      return { status: 201, body: await registerExistingAgent(currentContext, { ...body, companyId }) };
    }
    if (input.routeKey === ROUTE_KEYS.repairLink) {
      return { body: await repairAgentLink(currentContext, { ...body, companyId }) };
    }
    if (input.routeKey === ROUTE_KEYS.syncCosts) {
      return { body: await syncCosts(currentContext, { ...body, companyId }) };
    }
    if (input.routeKey === ROUTE_KEYS.lifecycle) {
      return { body: await requestLifecycle(currentContext, { ...body, companyId }) };
    }

    return { status: 404, body: { error: `Unknown Fleet Connector route: ${input.routeKey}` } };
  },

  async onHealth() {
    return {
      status: "ok",
      message: "Monolith Fleet Connector worker is running",
      details: {
        pluginId: PLUGIN_ID,
        surfaces: ["dashboard-widget", "sidebar-panel", "agent-detail-tab", "fleet-api-routes", "scheduled-poll", "scheduled-cost-sync"],
      },
    };
  },

  async onValidateConfig(config) {
    const normalized = normalizeConfig(config);
    const errors = [];
    const warnings = [];
    if (!normalized.fleetApiBaseUrl) errors.push("fleetApiBaseUrl is required.");
    if (!normalized.fleetApiTokenSecretRef) warnings.push("No Fleet API token secret is configured; requests will be anonymous.");
    if (Object.keys(normalized.tenantIdByCompanyId).length === 0 && !normalized.defaultTenantId) {
      warnings.push("No company-to-tenant mapping is configured.");
    }
    if (normalized.scheduledCostSyncApply && !normalized.enableCostSyncActions) {
      warnings.push("Scheduled cost sync apply also requires enableCostSyncActions.");
    }
    if (normalized.enableLifecycleActions && !normalized.lifecycleRequireApprovalRef) {
      warnings.push("Lifecycle actions can run without approval refs. Use only for trusted local smoke.");
    }
    return { ok: errors.length === 0, errors, warnings };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
