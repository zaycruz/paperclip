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
    enableCostSyncActions: coerceBoolean(
      source.enableCostSyncActions,
      DEFAULT_CONFIG.enableCostSyncActions,
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
    enableCostSyncActions: config.enableCostSyncActions,
    enableScheduledCostSync: config.enableScheduledCostSync,
    scheduledCostSyncApply: config.scheduledCostSyncApply,
    scheduledCostSyncHours: config.scheduledCostSyncHours,
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
      unmanaged: 0,
      runtimeErrors: 0,
      recommendations: ["Routine reconciliation has not been checked yet."],
    };
  }

  const summary = isPlainObject(result.summary) ? result.summary : {};
  return {
    status: cleanString(result.status) || "unknown",
    missing: numberValue(summary.missing, 0),
    drift: numberValue(summary.drift, 0),
    unmanaged: numberValue(summary.unmanaged, 0),
    runtimeErrors: numberValue(summary.runtime_errors, 0),
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

export function buildOverviewStatus(opsSummary, routineSummary) {
  if (opsSummary.status === "unlinked") return "unlinked";
  if (routineSummary.status === "drift" || routineSummary.status === "degraded") return "drift";
  if (opsSummary.degradedAgents > 0 || opsSummary.status === "degraded") return "degraded";
  return opsSummary.status || "unknown";
}
