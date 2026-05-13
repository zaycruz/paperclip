import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import {
  ACTION_KEYS,
  DATA_KEYS,
  JOB_KEYS,
  MANAGED_RESOURCE_KEYS,
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
  buildManagedRoutineReconciliationPayload,
  buildOverviewStatus,
  buildRegisterExistingPayload,
  buildRepairPayload,
  buildRoutineRepairRequest,
  buildRoutineAuthorityPreviewPayload,
  buildRoutineMirrorRequest,
  buildScheduledCostSyncParams,
  getManagedRoutineSet,
  clampHours,
  normalizeConfig,
  redactConfig,
  requireTenantId,
  summarizeOpsRollup,
  summarizeRoutineReconciliation,
} from "./logic.js";

let currentContext = null;
const BOARD_ONLY_API_ROUTES = new Set([
  ROUTE_KEYS.registerExisting,
  ROUTE_KEYS.repairLink,
  ROUTE_KEYS.routineRepair,
  ROUTE_KEYS.syncCosts,
  ROUTE_KEYS.lifecycle,
  ROUTE_KEYS.reconcileManagedResources,
  ROUTE_KEYS.routineAuthorityPreview,
  ROUTE_KEYS.managedRoutineReconciliation,
  ROUTE_KEYS.dryRunRoutineMirrorStatus,
  ROUTE_KEYS.approvedRoutineMirror,
]);

function stringField(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function approvalRefFromParams(params = {}) {
  return stringField(params.approval_ref)
    || stringField(params.approvalRef)
    || stringField(params.approval_id)
    || stringField(params.approvalId)
    || stringField(params.change_request_id)
    || stringField(params.changeRequestId);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function redactSensitiveText(value) {
  return String(value)
    .replace(/(authorization\s*[:=]\s*)Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "$1Bearer [REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[-_]?key|access[-_]?token|auth[-_]?token|secret)\s*[:=]\s*)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
}

function fleetErrorDetail(body, text) {
  const raw = body?.error || body?.detail || text.slice(0, 240);
  const clean = redactSensitiveText(raw).slice(0, 240).trim();
  return clean && clean !== "[object Object]" ? clean : "";
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

function managedResourcesStateKey(companyId) {
  return {
    scopeKind: "company",
    scopeId: companyId,
    namespace: STATE_NAMESPACE,
    stateKey: "managed-resources",
  };
}

async function getConfig(ctx) {
  return normalizeConfig(await ctx.config.get());
}

async function resolveFleetToken(ctx, config, companyId = "") {
  if (!config.fleetApiTokenSecretRef) return "";
  const resolved = await ctx.secrets.resolve(config.fleetApiTokenSecretRef, { companyId });
  if (typeof resolved === "string") return resolved;
  if (resolved && typeof resolved === "object") {
    return stringField(resolved.value) || stringField(resolved.secret) || stringField(resolved.token);
  }
  return "";
}

async function fleetRequest(ctx, config, path, options = {}) {
  const method = options.method || "GET";
  const token = await resolveFleetToken(ctx, config, options.companyId);
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
    const detail = fleetErrorDetail(body, text);
    throw new Error(`Fleet API ${method} ${path} failed with ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return body;
}

async function logGuardedMutationBlocked(ctx, input) {
  await ctx.activity.log({
    companyId: input.companyId,
    entityType: input.entityType ?? "plugin",
    entityId: input.entityId || undefined,
    message: `Blocked Fleet ${input.actionLabel} for tenant ${input.tenantId}: ${input.reason}`,
    metadata: {
      plugin: PLUGIN_ID,
      tenantId: input.tenantId,
      containerId: input.containerId || null,
      action: input.actionKey,
      operation: input.operation || null,
      status: "blocked",
      reason: input.reason,
      approvalRequired: true,
    },
  });
  await ctx.metrics.write("fleet.guarded_mutation_requests", 1, {
    tenant_id: input.tenantId,
    action: input.actionKey,
    status: "blocked",
  });
}

async function guardedMutationBlockedResult(ctx, input) {
  await logGuardedMutationBlocked(ctx, input);
  return {
    status: "blocked",
    approvalRequired: true,
    reason: input.reason,
    companyId: input.companyId,
    tenantId: input.tenantId,
    containerId: input.containerId || undefined,
  };
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
  await ctx.metrics.write("fleet.routine_degraded_links", overview.routineSummary.degradedLinks || 0, labels);
  await ctx.metrics.write("fleet.routine_revision_errors", overview.routineSummary.revisionErrors || 0, labels);
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
    { companyId, query: { hours } },
  );
  let routine = null;
  let routineError = null;
  try {
    routine = await fleetRequest(
      ctx,
      config,
      `/api/paperclip/companies/${encodeURIComponent(tenantId)}/routine-reconciliation`,
      { companyId, query: options.contractsPath ? { contracts_path: options.contractsPath } : {} },
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

function requireManagedResourceClients(ctx) {
  if (!ctx.agents?.managed || !ctx.projects?.managed || !ctx.routines?.managed) {
    throw new Error("Paperclip host does not expose plugin-managed resource clients");
  }
}

function summarizeManagedAgent(resolution) {
  return {
    resourceKind: "agent",
    resourceKey: MANAGED_RESOURCE_KEYS.agent,
    status: resolution?.status || "unknown",
    agentId: resolution?.agentId || null,
    agentStatus: resolution?.agent?.status || null,
    approvalId: resolution?.approvalId || null,
  };
}

function summarizeManagedProject(resolution) {
  return {
    resourceKind: "project",
    resourceKey: MANAGED_RESOURCE_KEYS.project,
    status: resolution?.status || "unknown",
    projectId: resolution?.projectId || null,
    projectStatus: resolution?.project?.status || null,
  };
}

function summarizeManagedRoutine(resolution) {
  return {
    resourceKind: "routine",
    resourceKey: MANAGED_RESOURCE_KEYS.routine,
    status: resolution?.status || "unknown",
    routineId: resolution?.routineId || null,
    routineStatus: resolution?.routine?.status || null,
    missingRefs: resolution?.missingRefs || [],
  };
}

function managedResourceError(resourceKind, resourceKey, error) {
  return {
    resourceKind,
    resourceKey,
    status: "error",
    error: errorMessage(error),
  };
}

function managedResourceReady(summary) {
  return Boolean(summary && !["missing", "missing_refs", "blocked", "error"].includes(summary.status));
}

async function captureManagedResource(makeSummary, makeError, fn) {
  try {
    return makeSummary(await fn());
  } catch (error) {
    return makeError(error);
  }
}

async function loadManagedResources(ctx, companyId, options = {}) {
  if (!companyId) {
    throw new Error("companyId is required");
  }
  requireManagedResourceClients(ctx);
  const config = await getConfig(ctx);
  const tenantId = requireTenantId(companyId, config);
  const reconcile = Boolean(options.reconcile);
  const mode = reconcile ? "reconcile" : "status";
  const agentMethod = reconcile ? "reconcile" : "get";
  const projectMethod = reconcile ? "reconcile" : "get";
  const routineMethod = reconcile ? "reconcile" : "get";

  const [agent, project] = await Promise.all([
    captureManagedResource(
      summarizeManagedAgent,
      (error) => managedResourceError("agent", MANAGED_RESOURCE_KEYS.agent, error),
      () => ctx.agents.managed[agentMethod](MANAGED_RESOURCE_KEYS.agent, companyId),
    ),
    captureManagedResource(
      summarizeManagedProject,
      (error) => managedResourceError("project", MANAGED_RESOURCE_KEYS.project, error),
      () => ctx.projects.managed[projectMethod](MANAGED_RESOURCE_KEYS.project, companyId),
    ),
  ]);

  let routine;
  if (agent.agentStatus === "pending_approval") {
    routine = {
      resourceKind: "routine",
      resourceKey: MANAGED_RESOURCE_KEYS.routine,
      status: "blocked",
      routineId: null,
      routineStatus: null,
      missingRefs: [],
      reason: "managed agent is pending board approval",
    };
  } else {
    routine = await captureManagedResource(
      summarizeManagedRoutine,
      (error) => managedResourceError("routine", MANAGED_RESOURCE_KEYS.routine, error),
      () => ctx.routines.managed[routineMethod](MANAGED_RESOURCE_KEYS.routine, companyId),
    );
  }

  const result = {
    checkedAt: new Date().toISOString(),
    companyId,
    tenantId,
    mode,
    ready: managedResourceReady(agent) && managedResourceReady(project) && managedResourceReady(routine),
    resources: {
      agent,
      project,
      routine,
    },
  };

  await ctx.state.set(managedResourcesStateKey(companyId), result);
  if (reconcile) {
    await ctx.activity.log({
      companyId,
      message: `Reconciled Fleet managed resources for tenant ${tenantId}`,
      metadata: {
        plugin: PLUGIN_ID,
        tenantId,
        ready: result.ready,
        agent: agent.status,
        project: project.status,
        routine: routine.status,
      },
    });
    await ctx.metrics.write("fleet.managed_resources_reconcile", 1, {
      tenant_id: tenantId,
      ready: String(result.ready),
    });
  }
  return result;
}

async function registerExistingAgent(ctx, params = {}) {
  const companyId = stringField(params.companyId);
  const containerId = stringField(params.containerId);
  if (!companyId || !containerId) {
    throw new Error("companyId and containerId are required");
  }
  const config = await getConfig(ctx);
  const tenantId = requireTenantId(companyId, config);
  if (!config.enableRegisterActions) {
    return guardedMutationBlockedResult(ctx, {
      companyId,
      tenantId,
      containerId,
      actionKey: ACTION_KEYS.registerExisting,
      actionLabel: `register-existing request for ${containerId}`,
      reason: "Register existing agent actions are disabled in plugin settings",
      entityType: "agent",
      entityId: stringField(params.paperclipAgentId) || stringField(params.paperclip_agent_id),
    });
  }
  const approvalRef = approvalRefFromParams(params);
  if (!approvalRef) {
    return guardedMutationBlockedResult(ctx, {
      companyId,
      tenantId,
      containerId,
      actionKey: ACTION_KEYS.registerExisting,
      actionLabel: `register-existing request for ${containerId}`,
      reason: "Register existing agent approvalRef or changeRequestId is required by plugin settings",
      entityType: "agent",
      entityId: stringField(params.paperclipAgentId) || stringField(params.paperclip_agent_id),
    });
  }
  const payload = buildRegisterExistingPayload(params, tenantId);
  const result = await fleetRequest(
    ctx,
    config,
    `/api/paperclip/agents/${encodeURIComponent(containerId)}/register-existing`,
    { companyId, method: "POST", body: payload },
  );
  await ctx.activity.log({
    companyId,
    entityType: "agent",
    entityId: stringField(params.paperclipAgentId) || stringField(params.paperclip_agent_id) || undefined,
    message: `Registered Fleet agent ${containerId} through Monolith Fleet Connector`,
    metadata: { plugin: PLUGIN_ID, containerId, tenantId, approvalRef },
  });
  await ctx.metrics.write("fleet.register_existing", 1, { tenant_id: tenantId, status: "applied" });
  return result;
}

async function repairAgentLink(ctx, params = {}) {
  const companyId = stringField(params.companyId);
  const containerId = stringField(params.containerId);
  if (!companyId || !containerId) {
    throw new Error("companyId and containerId are required");
  }
  const config = await getConfig(ctx);
  const tenantId = requireTenantId(companyId, config);
  if (!config.enableRepairActions) {
    return guardedMutationBlockedResult(ctx, {
      companyId,
      tenantId,
      containerId,
      actionKey: ACTION_KEYS.repairLink,
      actionLabel: `repair-link request for ${containerId}`,
      reason: "Repair actions are disabled in plugin settings",
      entityType: "agent",
      entityId: stringField(params.paperclipAgentId) || stringField(params.paperclip_agent_id),
    });
  }
  const approvalRef = approvalRefFromParams(params);
  if (!approvalRef) {
    return guardedMutationBlockedResult(ctx, {
      companyId,
      tenantId,
      containerId,
      actionKey: ACTION_KEYS.repairLink,
      actionLabel: `repair-link request for ${containerId}`,
      reason: "Repair approvalRef or changeRequestId is required by plugin settings",
      entityType: "agent",
      entityId: stringField(params.paperclipAgentId) || stringField(params.paperclip_agent_id),
    });
  }
  const result = await fleetRequest(
    ctx,
    config,
    `/api/paperclip/agents/${encodeURIComponent(containerId)}/repair`,
    { companyId, method: "POST", body: buildRepairPayload(params) },
  );
  await ctx.activity.log({
    companyId,
    entityType: "agent",
    entityId: stringField(params.paperclipAgentId) || stringField(params.paperclip_agent_id) || undefined,
    message: `Repaired Fleet link for ${containerId} through Monolith Fleet Connector`,
    metadata: { plugin: PLUGIN_ID, containerId, tenantId, approvalRef },
  });
  await ctx.metrics.write("fleet.repair_link", 1, { tenant_id: tenantId, status: "applied" });
  return result;
}

async function repairRoutineDrift(ctx, params = {}) {
  const companyId = stringField(params.companyId);
  if (!companyId) {
    throw new Error("companyId is required");
  }

  const config = await getConfig(ctx);
  const tenantId = requireTenantId(companyId, config);
  const request = buildRoutineRepairRequest(params, config);

  if (request.blocked) {
    const result = {
      status: "blocked",
      tenantId,
      companyId,
      reason: request.reason,
      approvalRequired: true,
      dryRun: request.dryRun,
    };
    await ctx.activity.log({
      companyId,
      message: `Blocked Fleet routine repair for tenant ${tenantId}: ${request.reason}`,
      metadata: {
        plugin: PLUGIN_ID,
        tenantId,
        status: result.status,
        reason: request.reason,
      },
    });
    await ctx.metrics.write("fleet.routine_repair", 1, {
      tenant_id: tenantId,
      mode: "blocked",
      status: "blocked",
    });
    return result;
  }

  try {
    if (request.dryRun) {
      const body = {
        dry_run: true,
        force: request.force,
      };
      if (request.contractsPath) body.contracts_path = request.contractsPath;
      const result = await fleetRequest(
        ctx,
        config,
        `/api/paperclip/companies/${encodeURIComponent(tenantId)}/routine-repair`,
        { companyId, method: "POST", body },
      );
      const plannedActions = Number(result?.summary?.planned_actions ?? result?.planned_actions?.length ?? 0) || 0;
      await ctx.activity.log({
        companyId,
        message: `Ran dry-run Fleet routine repair for tenant ${tenantId}: ${plannedActions} planned action${plannedActions === 1 ? "" : "s"}`,
        metadata: {
          plugin: PLUGIN_ID,
          tenantId,
          dryRun: true,
          status: result?.status || "unknown",
          plannedActions,
        },
      });
      await ctx.metrics.write("fleet.routine_repair", 1, {
        tenant_id: tenantId,
        mode: "dry_run",
        status: result?.status || "unknown",
      });
      return {
        mode: "dry_run",
        tenantId,
        companyId,
        result,
      };
    }

    const actionPayload = {
      tenant_id: tenantId,
      action_type: "paperclip.routine_repair",
      tool_name: "paperclip_routine_repair",
      risk_class: "operational_write",
      target_environment: request.targetEnvironment,
      idempotency_key: request.idempotencyKey || `paperclip-${companyId}-${tenantId}-routine-repair-${Date.now()}`,
      payload: {
        contracts_path: request.contractsPath || "/home/agent/.hermes/routine-contracts.yaml",
        force: request.force,
        approval_ref: request.approvalRef,
        reason: request.reason,
      },
    };
    const result = await fleetRequest(
      ctx,
      config,
      "/api/fleet-manager/actions",
      { companyId, method: "POST", body: actionPayload },
    );
    await ctx.activity.log({
      companyId,
      message: `Requested approval-bound Fleet routine repair for tenant ${tenantId}`,
      metadata: {
        plugin: PLUGIN_ID,
        tenantId,
        dryRun: false,
        approvalRef: request.approvalRef,
        fleetManagerActionId: result?.id,
        status: result?.status || "unknown",
        targetEnvironment: request.targetEnvironment,
      },
    });
    await ctx.metrics.write("fleet.routine_repair", 1, {
      tenant_id: tenantId,
      mode: "approval_request",
      status: result?.status || "unknown",
    });
    return {
      mode: "approval_request",
      tenantId,
      companyId,
      approvalRequired: true,
      result,
    };
  } catch (error) {
    const message = errorMessage(error);
    await ctx.activity.log({
      companyId,
      message: `Fleet routine repair failed for tenant ${tenantId}: ${message}`,
      metadata: {
        plugin: PLUGIN_ID,
        tenantId,
        dryRun: request.dryRun,
        error: message,
      },
    });
    await ctx.metrics.write("fleet.routine_repair", 1, {
      tenant_id: tenantId,
      mode: request.dryRun ? "dry_run" : "approval_request",
      status: "failed",
    });
    throw error;
  }
}

async function loadFleetLinkHealth(ctx, companyId, params = {}) {
  if (!companyId) {
    throw new Error("companyId is required");
  }
  const config = await getConfig(ctx);
  const tenantId = requireTenantId(companyId, config);
  const result = await fleetRequest(
    ctx,
    config,
    `/api/paperclip/companies/${encodeURIComponent(tenantId)}/fleet-link-health`,
    { companyId, query: { runtime_ref: stringField(params.runtimeRef) || stringField(params.runtime_ref) } },
  );
  return {
    companyId,
    tenantId,
    checkedAt: new Date().toISOString(),
    result,
  };
}

async function previewRoutineAuthority(ctx, params = {}) {
  const companyId = stringField(params.companyId);
  if (!companyId) {
    throw new Error("companyId is required");
  }
  const config = await getConfig(ctx);
  const tenantId = requireTenantId(companyId, config);
  const payload = buildRoutineAuthorityPreviewPayload({ ...params, companyId, tenantId }, config);
  const result = await fleetRequest(
    ctx,
    config,
    `/api/paperclip/companies/${encodeURIComponent(tenantId)}/routine-authority-preview`,
    { companyId, method: "POST", body: payload },
  );
  await ctx.metrics.write("fleet.routine_authority_preview", 1, {
    tenant_id: tenantId,
    status: result?.status || "unknown",
  });
  return { companyId, tenantId, payload, result };
}

async function reconcileManagedRoutines(ctx, params = {}) {
  const companyId = stringField(params.companyId);
  if (!companyId) {
    throw new Error("companyId is required");
  }
  const config = await getConfig(ctx);
  const tenantId = requireTenantId(companyId, config);
  const payload = buildManagedRoutineReconciliationPayload({ ...params, companyId, tenantId }, config);
  const result = await fleetRequest(
    ctx,
    config,
    `/api/paperclip/companies/${encodeURIComponent(tenantId)}/managed-routine-reconciliation`,
    { companyId, method: "POST", body: payload },
  );
  await ctx.activity.log({
    companyId,
    message: `Reconciled Paperclip-managed routine authority for tenant ${tenantId}`,
    metadata: {
      plugin: PLUGIN_ID,
      tenantId,
      routineSetKey: payload.routine_set_key,
      routineCount: payload.managed_routines.length,
      status: result?.status || "unknown",
      dryRun: payload.dry_run,
    },
  });
  await ctx.metrics.write("fleet.managed_routine_reconciliation", 1, {
    tenant_id: tenantId,
    status: result?.status || "unknown",
    dry_run: String(payload.dry_run),
  });
  return { companyId, tenantId, payload, result };
}

async function mirrorRoutineContracts(ctx, params = {}) {
  const companyId = stringField(params.companyId);
  if (!companyId) {
    throw new Error("companyId is required");
  }
  const config = await getConfig(ctx);
  const tenantId = requireTenantId(companyId, config);
  const request = buildRoutineMirrorRequest({ ...params, companyId, tenantId }, config);

  if (request.blocked) {
    return guardedMutationBlockedResult(ctx, {
      companyId,
      tenantId,
      actionKey: ACTION_KEYS.approvedRoutineMirror,
      actionLabel: "routine mirror request",
      reason: request.reason,
    });
  }

  if (request.dryRun) {
    const result = await fleetRequest(
      ctx,
      config,
      `/api/paperclip/companies/${encodeURIComponent(tenantId)}/routine-mirror-status`,
      { companyId, method: "POST", body: { ...request.payload, dry_run: true } },
    );
    await ctx.activity.log({
      companyId,
      message: `Ran dry-run Paperclip-to-Hermes routine mirror status for tenant ${tenantId}`,
      metadata: {
        plugin: PLUGIN_ID,
        tenantId,
        routineSetKey: request.payload.routine_set_key,
        routineCount: request.payload.managed_routines.length,
        status: result?.status || "unknown",
      },
    });
    await ctx.metrics.write("fleet.routine_mirror", 1, {
      tenant_id: tenantId,
      mode: "dry_run",
      status: result?.status || "unknown",
    });
    return { mode: "dry_run", companyId, tenantId, payload: request.payload, result };
  }

  const actionPayload = {
    tenant_id: tenantId,
    action_type: "paperclip.routine_contract_mirror",
    tool_name: "paperclip_routine_contract_mirror",
    risk_class: "operational_write",
    target_environment: request.targetEnvironment,
    idempotency_key: request.idempotencyKey || `paperclip-${companyId}-${tenantId}-routine-mirror-${Date.now()}`,
    payload: {
      ...request.payload,
      dry_run: false,
      approval_ref: request.approvalRef,
    },
  };
  const result = await fleetRequest(
    ctx,
    config,
    "/api/fleet-manager/actions",
    { companyId, method: "POST", body: actionPayload },
  );
  await ctx.activity.log({
    companyId,
    message: `Requested approval-bound Paperclip-to-Hermes routine mirror for tenant ${tenantId}`,
    metadata: {
      plugin: PLUGIN_ID,
      tenantId,
      approvalRef: request.approvalRef,
      routineSetKey: request.payload.routine_set_key,
      routineCount: request.payload.managed_routines.length,
      fleetManagerActionId: result?.id,
      status: result?.status || "unknown",
      targetEnvironment: request.targetEnvironment,
    },
  });
  await ctx.metrics.write("fleet.routine_mirror", 1, {
    tenant_id: tenantId,
    mode: "approval_request",
    status: result?.status || "unknown",
  });
  return {
    mode: "approval_request",
    companyId,
    tenantId,
    approvalRequired: true,
    result,
  };
}

async function syncCosts(ctx, params = {}) {
  const companyId = stringField(params.companyId);
  if (!companyId) {
    throw new Error("companyId is required");
  }
  const config = await getConfig(ctx);
  const payload = buildCostSyncPayload(params);
  const tenantId = requireTenantId(companyId, config);
  if (!payload.dry_run && !config.enableCostSyncActions) {
    return guardedMutationBlockedResult(ctx, {
      companyId,
      tenantId,
      actionKey: ACTION_KEYS.syncCosts,
      actionLabel: "cost-sync apply",
      reason: "Cost sync apply is disabled in plugin settings",
    });
  }
  const approvalRef = approvalRefFromParams(params);
  if (!payload.dry_run && !approvalRef) {
    return guardedMutationBlockedResult(ctx, {
      companyId,
      tenantId,
      actionKey: ACTION_KEYS.syncCosts,
      actionLabel: "cost-sync apply",
      reason: "Cost sync apply approvalRef or changeRequestId is required by plugin settings",
    });
  }
  const result = await fleetRequest(
    ctx,
    config,
    `/api/paperclip/companies/${encodeURIComponent(tenantId)}/cost-sync`,
    { companyId, method: "POST", body: payload },
  );
  await ctx.activity.log({
    companyId,
    message: payload.dry_run
      ? `Ran dry-run Fleet cost sync for tenant ${tenantId}`
      : `Applied Fleet cost sync for tenant ${tenantId}`,
    metadata: { plugin: PLUGIN_ID, tenantId, dryRun: payload.dry_run, approvalRef },
  });
  await ctx.metrics.write("fleet.cost_sync", 1, {
    tenant_id: tenantId,
    dry_run: String(payload.dry_run),
  });
  return result;
}

async function logLifecycleBlocked(ctx, input) {
  await ctx.activity.log({
    companyId: input.companyId,
    entityType: "agent",
    entityId: input.paperclipAgentId || undefined,
    message: `Blocked Fleet lifecycle ${input.operation || "request"} for ${input.containerId}: ${input.reason}`,
    metadata: {
      plugin: PLUGIN_ID,
      containerId: input.containerId,
      tenantId: input.tenantId,
      operation: input.operation || null,
      status: "blocked",
      reason: input.reason,
      approvalRequired: input.approvalRequired,
    },
  });
  await ctx.metrics.write("fleet.lifecycle_requests", 1, {
    tenant_id: input.tenantId,
    operation: input.operation || "unknown",
    status: "blocked",
  });
}

async function requestLifecycle(ctx, params = {}) {
  const companyId = stringField(params.companyId);
  const containerId = stringField(params.containerId);
  if (!companyId || !containerId) {
    throw new Error("companyId and containerId are required");
  }

  const config = await getConfig(ctx);
  const requestedOperation = stringField(params.operation) || stringField(params.action) || "request";
  const tenantId = requireTenantId(companyId, config);
  if (!config.enableLifecycleActions) {
    const reason = "Lifecycle actions are disabled in plugin settings";
    await logLifecycleBlocked(ctx, {
      companyId,
      containerId,
      tenantId,
      operation: requestedOperation,
      reason,
      approvalRequired: config.lifecycleRequireApprovalRef,
    });
    return {
      status: "blocked",
      approvalRequired: config.lifecycleRequireApprovalRef,
      reason,
      containerId,
      tenantId,
    };
  }

  let action;
  try {
    action = buildLifecycleActionParams(params, config);
  } catch (error) {
    const reason = errorMessage(error);
    await logLifecycleBlocked(ctx, {
      companyId,
      containerId,
      tenantId,
      operation: requestedOperation,
      reason,
      approvalRequired: config.lifecycleRequireApprovalRef,
    });
    return {
      status: "blocked",
      approvalRequired: config.lifecycleRequireApprovalRef,
      reason,
      containerId,
      tenantId,
    };
  }

  let linkedAgent = null;
  try {
    const overview = await loadOverview(ctx, companyId);
    linkedAgent = Array.isArray(overview.rollup?.agents)
      ? overview.rollup.agents.find((agent) => agent?.container_id === containerId || agent?.containerId === containerId)
      : null;
    if (!linkedAgent) {
      throw new Error(`Container ${containerId} is not linked to Paperclip company ${companyId}`);
    }

    const result = await fleetRequest(
      ctx,
      config,
      `/api/containers/${encodeURIComponent(containerId)}/${action.operation}`,
      { companyId, method: "POST", query: { async: "true" } },
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
        status: "requested",
      },
    });
    await ctx.metrics.write("fleet.lifecycle_requests", 1, {
      tenant_id: tenantId,
      operation: action.operation,
      status: "requested",
    });
    return {
      operation: action.operation,
      approvalRef: action.approvalRef,
      containerId,
      tenantId,
      result,
    };
  } catch (error) {
    const message = errorMessage(error);
    await ctx.activity.log({
      companyId,
      entityType: "agent",
      entityId: linkedAgent?.paperclip_agent_id || linkedAgent?.paperclipAgentId || undefined,
      message: `Fleet lifecycle ${action.operation} failed for ${containerId}: ${message}`,
      metadata: {
        plugin: PLUGIN_ID,
        containerId,
        tenantId,
        operation: action.operation,
        approvalRef: action.approvalRef,
        reason: action.reason,
        error: message,
        status: "failed",
      },
    });
    await ctx.metrics.write("fleet.lifecycle_requests", 1, {
      tenant_id: tenantId,
      operation: action.operation,
      status: "failed",
    });
    throw error;
  }
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

    ctx.data.register(DATA_KEYS.managedResources, async (params) => {
      const companyId = stringField(params.companyId);
      if (!companyId) throw new Error("companyId is required");
      return loadManagedResources(ctx, companyId);
    });

    ctx.data.register(DATA_KEYS.ijtManagedRoutines, async (params) => {
      const config = await getConfig(ctx);
      return getManagedRoutineSet(params, config);
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
    ctx.actions.register(ACTION_KEYS.routineAuthorityPreview, async (params) => previewRoutineAuthority(ctx, params));
    ctx.actions.register(ACTION_KEYS.managedRoutineReconciliation, async (params) => reconcileManagedRoutines(ctx, params));
    ctx.actions.register(ACTION_KEYS.dryRunRoutineMirrorStatus, async (params) => mirrorRoutineContracts(ctx, { ...params, dryRun: true }));
    ctx.actions.register(ACTION_KEYS.approvedRoutineMirror, async (params) => mirrorRoutineContracts(ctx, params));
    ctx.actions.register(ACTION_KEYS.repairLink, async (params) => repairAgentLink(ctx, params));
    ctx.actions.register(ACTION_KEYS.routineRepair, async (params) => repairRoutineDrift(ctx, params));
    ctx.actions.register(ACTION_KEYS.syncCosts, async (params) => syncCosts(ctx, params));
    ctx.actions.register(ACTION_KEYS.lifecycle, async (params) => requestLifecycle(ctx, params));
    ctx.actions.register(ACTION_KEYS.reconcileManagedResources, async (params) => {
      const companyId = stringField(params.companyId);
      if (!companyId) throw new Error("companyId is required");
      return loadManagedResources(ctx, companyId, { reconcile: true });
    });

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
    if (input.routeKey === ROUTE_KEYS.linkHealth) {
      return { body: await loadFleetLinkHealth(currentContext, companyId, query) };
    }
    if (BOARD_ONLY_API_ROUTES.has(input.routeKey) && input.actor?.actorType !== "user") {
      return {
        status: 403,
        body: { error: "Board access required for Fleet Connector mutation routes" },
      };
    }
    if (input.routeKey === ROUTE_KEYS.routineAuthorityPreview) {
      return { body: await previewRoutineAuthority(currentContext, { ...body, companyId }) };
    }
    if (input.routeKey === ROUTE_KEYS.managedRoutineReconciliation) {
      return { body: await reconcileManagedRoutines(currentContext, { ...body, companyId }) };
    }
    if (input.routeKey === ROUTE_KEYS.dryRunRoutineMirrorStatus) {
      return { body: await mirrorRoutineContracts(currentContext, { ...body, companyId, dryRun: true }) };
    }
    if (input.routeKey === ROUTE_KEYS.approvedRoutineMirror) {
      return { body: await mirrorRoutineContracts(currentContext, { ...body, companyId }) };
    }
    if (input.routeKey === ROUTE_KEYS.registerExisting) {
      return { status: 201, body: await registerExistingAgent(currentContext, { ...body, companyId }) };
    }
    if (input.routeKey === ROUTE_KEYS.repairLink) {
      return { body: await repairAgentLink(currentContext, { ...body, companyId }) };
    }
    if (input.routeKey === ROUTE_KEYS.routineRepair) {
      return { body: await repairRoutineDrift(currentContext, { ...body, companyId }) };
    }
    if (input.routeKey === ROUTE_KEYS.syncCosts) {
      return { body: await syncCosts(currentContext, { ...body, companyId }) };
    }
    if (input.routeKey === ROUTE_KEYS.lifecycle) {
      return { body: await requestLifecycle(currentContext, { ...body, companyId }) };
    }
    if (input.routeKey === ROUTE_KEYS.reconcileManagedResources) {
      return { body: await loadManagedResources(currentContext, companyId, { reconcile: true }) };
    }

    return { status: 404, body: { error: `Unknown Fleet Connector route: ${input.routeKey}` } };
  },

  async onHealth() {
    return {
      status: "ok",
      message: "Monolith Fleet Connector worker is running",
      details: {
        pluginId: PLUGIN_ID,
        surfaces: ["dashboard-widget", "sidebar-panel", "agent-detail-tab", "fleet-api-routes", "routine-repair-approval", "managed-resources", "scheduled-poll", "scheduled-cost-sync"],
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
    if (normalized.enableRoutineRepairActions && !normalized.routineRepairRequireApprovalRef) {
      warnings.push("Routine repair actions can request apply without approval refs. Use only for trusted local smoke.");
    }
    if (normalized.enableRoutineMirrorActions && !normalized.routineMirrorRequireApprovalRef) {
      warnings.push("Routine mirror actions can request apply without approval refs. Use only for trusted local smoke.");
    }
    return { ok: errors.length === 0, errors, warnings };
  },
});

export default plugin;
if (process.env.PAPERCLIP_PLUGIN_DISABLE_AUTORUN !== "1") {
  runWorker(plugin, import.meta.url);
}
