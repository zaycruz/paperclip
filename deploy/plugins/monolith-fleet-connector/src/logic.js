import { DEFAULT_CONFIG } from "./constants.js";

const MAX_HOURS = 720;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function firstString(source, ...keys) {
  for (const key of keys) {
    const value = cleanString(source?.[key]);
    if (value) return value;
  }
  return "";
}

function presentArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function coerceBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

export function clampHours(value, fallback = 24) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(MAX_HOURS, Math.trunc(parsed)));
}

export function clampPercent(value, fallback = 90) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(parsed)));
}

export function normalizeConfig(raw = {}) {
  const source = isPlainObject(raw) ? raw : {};
  const tenantIdByCompanyId = {};
  if (isPlainObject(source.tenantIdByCompanyId)) {
    for (const [companyId, tenantId] of Object.entries(source.tenantIdByCompanyId)) {
      const cleanCompanyId = cleanString(companyId);
      const cleanTenantId = cleanString(tenantId);
      if (cleanCompanyId && cleanTenantId) {
        tenantIdByCompanyId[cleanCompanyId] = cleanTenantId;
      }
    }
  }

  return {
    ...DEFAULT_CONFIG,
    fleetApiBaseUrl: cleanString(source.fleetApiBaseUrl).replace(/\/+$/, ""),
    fleetApiTokenSecretRef: cleanString(source.fleetApiTokenSecretRef),
    tenantIdByCompanyId,
    defaultTenantId: cleanString(source.defaultTenantId),
    enableRegisterActions: coerceBoolean(
      source.enableRegisterActions,
      DEFAULT_CONFIG.enableRegisterActions,
    ),
    enableRepairActions: coerceBoolean(
      source.enableRepairActions,
      DEFAULT_CONFIG.enableRepairActions,
    ),
    enableRoutineRepairActions: coerceBoolean(
      source.enableRoutineRepairActions,
      DEFAULT_CONFIG.enableRoutineRepairActions,
    ),
    routineRepairRequireApprovalRef: coerceBoolean(
      source.routineRepairRequireApprovalRef,
      DEFAULT_CONFIG.routineRepairRequireApprovalRef,
    ),
    enableCostSyncActions: coerceBoolean(
      source.enableCostSyncActions,
      DEFAULT_CONFIG.enableCostSyncActions,
    ),
    enableLifecycleActions: coerceBoolean(
      source.enableLifecycleActions,
      DEFAULT_CONFIG.enableLifecycleActions,
    ),
    lifecycleRequireApprovalRef: coerceBoolean(
      source.lifecycleRequireApprovalRef,
      DEFAULT_CONFIG.lifecycleRequireApprovalRef,
    ),
    enableBudgetAlerts: coerceBoolean(
      source.enableBudgetAlerts,
      DEFAULT_CONFIG.enableBudgetAlerts,
    ),
    budgetAlertUtilizationPercent: clampPercent(
      source.budgetAlertUtilizationPercent,
      DEFAULT_CONFIG.budgetAlertUtilizationPercent,
    ),
    enableScheduledCostSync: coerceBoolean(
      source.enableScheduledCostSync,
      DEFAULT_CONFIG.enableScheduledCostSync,
    ),
    scheduledCostSyncApply: coerceBoolean(
      source.scheduledCostSyncApply,
      DEFAULT_CONFIG.scheduledCostSyncApply,
    ),
    scheduledCostSyncHours: clampHours(
      source.scheduledCostSyncHours,
      DEFAULT_CONFIG.scheduledCostSyncHours,
    ),
  };
}

export function redactConfig(rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  return {
    fleetApiBaseUrl: config.fleetApiBaseUrl,
    fleetApiTokenSecretRefConfigured: Boolean(config.fleetApiTokenSecretRef),
    configuredCompanyIds: Object.keys(config.tenantIdByCompanyId).sort(),
    defaultTenantConfigured: Boolean(config.defaultTenantId),
    enableRegisterActions: config.enableRegisterActions,
    enableRepairActions: config.enableRepairActions,
    enableRoutineRepairActions: config.enableRoutineRepairActions,
    routineRepairRequireApprovalRef: config.routineRepairRequireApprovalRef,
    enableCostSyncActions: config.enableCostSyncActions,
    enableLifecycleActions: config.enableLifecycleActions,
    lifecycleRequireApprovalRef: config.lifecycleRequireApprovalRef,
    enableBudgetAlerts: config.enableBudgetAlerts,
    budgetAlertUtilizationPercent: config.budgetAlertUtilizationPercent,
    enableScheduledCostSync: config.enableScheduledCostSync,
    scheduledCostSyncApply: config.scheduledCostSyncApply,
    scheduledCostSyncHours: config.scheduledCostSyncHours,
  };
}

function revisionContext(entry = {}) {
  const revision = isPlainObject(entry.paperclip_revision)
    ? entry.paperclip_revision
    : isPlainObject(entry.revision)
      ? entry.revision
      : {};
  const latest = isPlainObject(revision.latest) ? revision.latest : {};
  const latestRevisionId = firstString(entry, "latestRevisionId") || firstString(latest, "id");
  const latestRevisionNumber = numberValue(entry.latestRevisionNumber ?? latest.revision_number, 0);
  return {
    routineId: firstString(entry, "paperclip_routine_id", "id"),
    title: firstString(entry, "title"),
    status: cleanString(revision.status) || "unknown",
    count: numberValue(revision.count, 0),
    hasRestoreHistory: Boolean(revision.has_restore_history),
    latestRevisionId: latestRevisionId || null,
    latestRevisionNumber,
    latestChangeSummary: firstString(latest, "change_summary") || null,
    latestCreatedAt: firstString(latest, "created_at") || null,
  };
}

function collectRoutineRevisionContext(result = {}) {
  const entries = [
    ...presentArray(result.matches),
    ...presentArray(result.drift),
    ...presentArray(result.unmanaged_paperclip_routines),
    ...presentArray(result.paperclip_routines),
  ];
  const revisions = entries.map(revisionContext).filter((entry) => entry.routineId);
  const latest = revisions
    .filter((entry) => entry.latestCreatedAt)
    .sort((left, right) => String(right.latestCreatedAt).localeCompare(String(left.latestCreatedAt)))[0] || null;
  return {
    count: revisions.length,
    latest,
    restoreCandidates: revisions.filter((entry) => entry.hasRestoreHistory).length,
    degraded: revisions.filter((entry) => entry.status && entry.status !== "ready").length,
  };
}

export function resolveTenantId(companyId, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  const cleanCompanyId = cleanString(companyId);
  if (cleanCompanyId && config.tenantIdByCompanyId[cleanCompanyId]) {
    return config.tenantIdByCompanyId[cleanCompanyId];
  }
  return config.defaultTenantId || null;
}

export function requireTenantId(companyId, rawConfig = {}) {
  const tenantId = resolveTenantId(companyId, rawConfig);
  if (!tenantId) {
    throw new Error(`No Monolith tenant mapping configured for Paperclip company "${companyId || "unknown"}"`);
  }
  return tenantId;
}

export function buildFleetUrl(rawConfig, path, query = {}) {
  const config = normalizeConfig(rawConfig);
  if (!config.fleetApiBaseUrl) {
    throw new Error("fleetApiBaseUrl is required");
  }

  let requestPath = String(path || "");
  requestPath = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
  if (config.fleetApiBaseUrl.endsWith("/api") && requestPath.startsWith("/api/")) {
    requestPath = requestPath.slice(4);
  }

  const url = new URL(`${config.fleetApiBaseUrl}${requestPath}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== "") {
          url.searchParams.append(key, String(item));
        }
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export function authorizationHeaders(token, extra = {}) {
  const headers = {
    accept: "application/json",
    ...extra,
  };
  const cleanToken = cleanString(token);
  if (cleanToken) {
    headers.authorization = `Bearer ${cleanToken}`;
  }
  return headers;
}

export function summarizeOpsRollup(rollup = {}) {
  const summary = isPlainObject(rollup.summary) ? rollup.summary : {};
  const agents = Array.isArray(rollup.agents) ? rollup.agents : [];
  const liveness = isPlainObject(summary.liveness) ? summary.liveness : {};
  const cost = isPlainObject(summary.cost) ? summary.cost : {};
  const budget = isPlainObject(summary.budget) ? summary.budget : {};
  const linkedAgents = numberValue(summary.linked_agents, agents.length);
  const activeAgents = numberValue(liveness.active, 0);
  const degradedAgents = agents.filter((agent) => agent?.liveness_status && agent.liveness_status !== "active").length
    || Math.max(0, linkedAgents - activeAgents);

  return {
    status: cleanString(rollup.status) || (degradedAgents > 0 ? "degraded" : "active"),
    linkedAgents,
    activeAgents,
    degradedAgents,
    messageCount: numberValue(cost.message_count, 0),
    totalTokens: numberValue(cost.total_tokens, 0),
    totalCost: numberValue(cost.total_cost, 0),
    budgetActiveIncidents: numberValue(budget.active_incident_count, 0),
    pendingBudgetApprovals: numberValue(budget.pending_approval_count, 0),
    budgetMaxUtilizationPercent: numberValue(budget.max_utilization_percent, 0),
    routineCandidates: numberValue(summary.routine_contract_candidates, 0),
    recommendations: Array.isArray(rollup.recommendations) ? rollup.recommendations.filter(Boolean) : [],
  };
}

export function summarizeRoutineReconciliation(result = null) {
  if (!isPlainObject(result)) {
    return {
      status: "not_checked",
      missing: 0,
      drift: 0,
      matched: 0,
      degradedLinks: 0,
      unmanaged: 0,
      runtimeErrors: 0,
      revisionErrors: 0,
      contractRoutines: 0,
      paperclipRoutines: 0,
      runtimeSources: 0,
      latestRevision: null,
      revisionCount: 0,
      restoreCandidates: 0,
      recommendations: ["Routine reconciliation has not been checked yet."],
    };
  }

  const summary = isPlainObject(result.summary) ? result.summary : {};
  const revision = collectRoutineRevisionContext(result);
  return {
    status: cleanString(result.status) || "unknown",
    missing: numberValue(summary.missing, 0),
    drift: numberValue(summary.drift, 0),
    matched: numberValue(summary.matched, 0),
    degradedLinks: numberValue(summary.degraded_links, 0),
    unmanaged: numberValue(summary.unmanaged, 0),
    runtimeErrors: numberValue(summary.runtime_errors, 0),
    revisionErrors: numberValue(summary.revision_errors, 0),
    contractRoutines: numberValue(summary.contract_routines, 0),
    paperclipRoutines: numberValue(summary.paperclip_routines, 0),
    runtimeSources: numberValue(summary.runtime_sources, 0),
    latestRevision: revision.latest,
    revisionCount: revision.count,
    restoreCandidates: revision.restoreCandidates,
    degradedRevisionLinks: revision.degraded,
    recommendations: Array.isArray(result.recommendations) ? result.recommendations.filter(Boolean) : [],
  };
}

export function buildRegisterExistingPayload(params = {}, tenantId) {
  const payload = {};
  const cleanTenantId = cleanString(tenantId);
  if (cleanTenantId) payload.tenant_id = cleanTenantId;

  const stringMappings = [
    ["paperclip_agent_id", "paperclipAgentId"],
    ["agent_name", "agentName"],
    ["agent_role", "agentRole"],
    ["title", "title"],
    ["reports_to_agent_id", "reportsToAgentId"],
    ["reports_to_container_id", "reportsToContainerId"],
    ["capabilities", "capabilities"],
    ["adapter_url", "adapterUrl"],
    ["gateway_secret", "gatewaySecret"],
    ["provision_job_id", "provisionJobId"],
  ];
  for (const [snakeKey, camelKey] of stringMappings) {
    const value = firstString(params, snakeKey, camelKey);
    if (value) payload[snakeKey] = value;
  }

  const skills = Array.isArray(params.skills)
    ? params.skills
    : cleanString(params.skills).split(",");
  const cleanSkills = skills.map((skill) => cleanString(skill)).filter(Boolean);
  if (cleanSkills.length > 0) {
    payload.skills = cleanSkills;
  }

  return payload;
}

export function buildRepairPayload(params = {}) {
  const payload = {};
  const ip = firstString(params, "ip");
  const adapterUrl = firstString(params, "adapter_url", "adapterUrl");
  const provisionJobId = firstString(params, "provision_job_id", "provisionJobId");
  if (ip) payload.ip = ip;
  if (adapterUrl) payload.adapter_url = adapterUrl;
  if (provisionJobId) payload.provision_job_id = provisionJobId;
  return payload;
}

export function buildRoutineRepairRequest(params = {}, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  const dryRun = params.apply === true
    ? false
    : coerceBoolean(params.dry_run ?? params.dryRun, true);
  const approvalRef = firstString(
    params,
    "approval_ref",
    "approvalRef",
    "approval_id",
    "approvalId",
    "change_request_id",
    "changeRequestId",
  );
  const contractsPath = firstString(params, "contracts_path", "contractsPath");
  const targetEnvironment = firstString(params, "target_environment", "targetEnvironment")
    || (config.fleetApiBaseUrl.toLowerCase().includes("staging") ? "staging" : "production");
  const force = coerceBoolean(params.force, false);
  const reason = firstString(params, "reason");

  if (!dryRun && !config.enableRoutineRepairActions) {
    return {
      dryRun,
      blocked: true,
      reason: "Routine repair apply is disabled in plugin settings",
      approvalRef,
      contractsPath,
      force,
      targetEnvironment,
    };
  }

  if (!dryRun && config.routineRepairRequireApprovalRef && !approvalRef) {
    return {
      dryRun,
      blocked: true,
      reason: "Routine repair approvalRef or changeRequestId is required by plugin settings",
      approvalRef,
      contractsPath,
      force,
      targetEnvironment,
    };
  }

  return {
    dryRun,
    blocked: false,
    approvalRef,
    contractsPath,
    force,
    reason,
    targetEnvironment,
    idempotencyKey: firstString(params, "idempotency_key", "idempotencyKey"),
  };
}

export function buildLifecycleActionParams(params = {}, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  const operation = firstString(params, "operation", "action").toLowerCase();
  if (!["pause", "resume"].includes(operation)) {
    throw new Error("Lifecycle operation must be 'pause' or 'resume'");
  }
  const approvalRef = firstString(
    params,
    "approval_ref",
    "approvalRef",
    "approval_id",
    "approvalId",
    "change_request_id",
    "changeRequestId",
  );
  if (config.lifecycleRequireApprovalRef && !approvalRef) {
    throw new Error("Lifecycle approvalRef or changeRequestId is required by plugin settings");
  }
  return {
    operation,
    approvalRef,
    reason: firstString(params, "reason"),
  };
}

export function buildCostSyncPayload(params = {}) {
  const dryRun = params.apply === true
    ? false
    : coerceBoolean(params.dry_run ?? params.dryRun, true);
  return {
    hours: clampHours(params.hours, 24),
    dry_run: dryRun,
    force: coerceBoolean(params.force, false),
  };
}

export function buildScheduledCostSyncParams(rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  return {
    hours: config.scheduledCostSyncHours,
    dryRun: !config.scheduledCostSyncApply,
  };
}

export function buildBudgetAlertSignal(rawSummary = {}, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  if (!config.enableBudgetAlerts) return null;

  const activeIncidents = numberValue(rawSummary.budgetActiveIncidents, 0);
  const pendingApprovals = numberValue(rawSummary.pendingBudgetApprovals, 0);
  const maxUtilizationPercent = numberValue(rawSummary.budgetMaxUtilizationPercent, 0);
  const thresholdPercent = config.budgetAlertUtilizationPercent;
  if (activeIncidents <= 0 && pendingApprovals <= 0 && maxUtilizationPercent < thresholdPercent) {
    return null;
  }

  const utilization = Math.round(maxUtilizationPercent * 100) / 100;
  const reasons = [];
  if (activeIncidents > 0) {
    reasons.push(`${activeIncidents} active budget incident${activeIncidents === 1 ? "" : "s"}`);
  }
  if (pendingApprovals > 0) {
    reasons.push(`${pendingApprovals} pending budget approval${pendingApprovals === 1 ? "" : "s"}`);
  }
  if (maxUtilizationPercent >= thresholdPercent) {
    reasons.push(`${utilization}% max utilization`);
  }

  const severity = activeIncidents > 0 ? "critical" : "warning";
  return {
    severity,
    activeIncidents,
    pendingApprovals,
    maxUtilizationPercent: utilization,
    thresholdPercent,
    reasons,
    fingerprint: `${severity}:${activeIncidents}:${pendingApprovals}:${utilization}:${thresholdPercent}`,
    message: `Fleet budget ${severity}: ${reasons.join(", ")}`,
  };
}

export function buildOverviewStatus(opsSummary, routineSummary) {
  if (opsSummary.status === "unlinked") return "unlinked";
  if (
    routineSummary.status === "drift"
    || routineSummary.status === "degraded"
    || routineSummary.degradedLinks > 0
    || routineSummary.revisionErrors > 0
  ) return "drift";
  if (opsSummary.degradedAgents > 0 || opsSummary.status === "degraded") return "degraded";
  return opsSummary.status || "unknown";
}
