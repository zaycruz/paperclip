import React from "react";
import { useHostContext, usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { ACTION_KEYS, DATA_KEYS } from "../constants.js";

const e = React.createElement;

const panelStyle = {
  display: "grid",
  gap: 10,
  fontFamily: "inherit",
  fontSize: 13,
  lineHeight: 1.4,
};

const rowStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};

const metricGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 8,
};

const metricStyle = {
  border: "1px solid var(--border-color, currentColor)",
  borderRadius: 6,
  padding: 8,
};

const buttonStyle = {
  border: "1px solid var(--border-color, currentColor)",
  borderRadius: 6,
  padding: "6px 10px",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
};

function companyIdFromContext(context) {
  return context?.companyId || context?.company?.id || "";
}

function statusLabel(value) {
  return value || "unknown";
}

function Metric({ label, value }) {
  return e(
    "div",
    { style: metricStyle },
    e("div", { style: { opacity: 0.68, marginBottom: 2 } }, label),
    e("strong", null, value),
  );
}

function Recommendations({ items }) {
  const rows = Array.isArray(items) ? items.filter(Boolean).slice(0, 4) : [];
  if (rows.length === 0) return null;
  return e(
    "ul",
    { style: { margin: 0, paddingLeft: 18 } },
    ...rows.map((item) => e("li", { key: item }, item)),
  );
}

function OverviewBody({ overview }) {
  if (!overview) return e("div", null, "No Fleet overview has been loaded.");
  const summary = overview.summary || {};
  const routine = overview.routineSummary || {};
  const recommendations = [
    ...(summary.recommendations || []),
    ...(routine.recommendations || []),
    ...(overview.routineError ? [`Routine reconciliation error: ${overview.routineError}`] : []),
  ];
  return e(
    "div",
    { style: panelStyle },
    e(
      "div",
      { style: rowStyle },
      e("strong", null, statusLabel(overview.status)),
      e("code", null, overview.tenantId || "unmapped"),
    ),
    e(
      "div",
      { style: metricGridStyle },
      e(Metric, { label: "Linked", value: summary.linkedAgents ?? 0 }),
      e(Metric, { label: "Degraded", value: summary.degradedAgents ?? 0 }),
      e(Metric, { label: "Tokens", value: summary.totalTokens ?? 0 }),
      e(Metric, { label: "Cost", value: `$${Number(summary.totalCost || 0).toFixed(4)}` }),
      e(Metric, { label: "Budget Incidents", value: summary.budgetActiveIncidents ?? 0 }),
      e(Metric, { label: "Budget Approvals", value: summary.pendingBudgetApprovals ?? 0 }),
      e(Metric, { label: "Routine Drift", value: (routine.missing || 0) + (routine.drift || 0) + (routine.unmanaged || 0) }),
      e(Metric, { label: "Checked", value: overview.checkedAt ? new Date(overview.checkedAt).toLocaleTimeString() : "never" }),
    ),
    e(Recommendations, { items: recommendations }),
  );
}

function useFleetOverview(companyId) {
  return usePluginData(DATA_KEYS.overview, companyId ? { companyId } : {});
}

function FleetPanel({ context }) {
  const hostContext = useHostContext();
  const companyId = companyIdFromContext(context || hostContext);
  const { data, loading, error, refresh } = useFleetOverview(companyId);
  const refreshOverview = usePluginAction(ACTION_KEYS.refreshOverview);

  if (!companyId) return e("div", { style: panelStyle }, "No company context is available.");
  if (loading) return e("div", { style: panelStyle }, "Loading Fleet overview...");
  if (error) return e("div", { style: panelStyle }, `Fleet overview error: ${error.message}`);

  return e(
    "section",
    { style: panelStyle, "aria-label": "Monolith Fleet Connector" },
    e(
      "div",
      { style: rowStyle },
      e("strong", null, "Monolith Fleet"),
      e(
        "button",
        {
          type: "button",
          style: buttonStyle,
          onClick: async () => {
            await refreshOverview({ companyId });
            refresh();
          },
        },
        "Refresh",
      ),
    ),
    e(OverviewBody, { overview: data }),
  );
}

export function FleetHealthWidget(props) {
  return e(FleetPanel, props);
}

export function FleetConnectorPanel(props) {
  return e(FleetPanel, props);
}

export function FleetConnectorPage(props) {
  return e("main", { style: panelStyle }, e(FleetPanel, props));
}

export function AgentFleetTab({ context }) {
  const companyId = companyIdFromContext(context);
  const { data, loading, error, refresh } = useFleetOverview(companyId);
  const repair = usePluginAction(ACTION_KEYS.repairLink);
  const entityId = context?.entityId || context?.agentId || "";
  const agentRow = Array.isArray(data?.rollup?.agents)
    ? data.rollup.agents.find((agent) => agent.paperclip_agent_id === entityId || agent.container_id === entityId)
    : null;

  if (loading) return e("div", { style: panelStyle }, "Loading Fleet agent state...");
  if (error) return e("div", { style: panelStyle }, `Fleet agent error: ${error.message}`);
  if (!agentRow) return e("div", { style: panelStyle }, "No linked Fleet container found for this agent.");

  return e(
    "section",
    { style: panelStyle, "aria-label": "Fleet agent link" },
    e(
      "div",
      { style: rowStyle },
      e("strong", null, statusLabel(agentRow.liveness_status)),
      e("code", null, agentRow.container_id),
    ),
    e(Metric, { label: "Runtime", value: agentRow.runtime_agent_status || agentRow.fleet_status || "unknown" }),
    e(Metric, { label: "Adapter", value: agentRow.adapter_url || "not set" }),
    e(
      "button",
      {
        type: "button",
        style: buttonStyle,
        onClick: async () => {
          await repair({ companyId, containerId: agentRow.container_id });
          refresh();
        },
      },
      "Repair Link",
    ),
  );
}

export function FleetConnectorSettings() {
  const { data, loading, error } = usePluginData(DATA_KEYS.config);
  if (loading) return e("div", { style: panelStyle }, "Loading Fleet Connector settings...");
  if (error) return e("div", { style: panelStyle }, `Settings error: ${error.message}`);
  return e(
    "section",
    { style: panelStyle, "aria-label": "Fleet connector settings" },
    e("strong", null, "Fleet Connector"),
    e(Metric, { label: "Fleet API", value: data?.fleetApiBaseUrl || "not configured" }),
    e(Metric, { label: "Secret", value: data?.fleetApiTokenSecretRefConfigured ? "configured" : "missing" }),
    e(Metric, { label: "Company mappings", value: data?.configuredCompanyIds?.length ?? 0 }),
    e(Metric, { label: "Repair", value: data?.enableRepairActions ? "enabled" : "disabled" }),
    e(Metric, { label: "Register", value: data?.enableRegisterActions ? "enabled" : "disabled" }),
    e(Metric, { label: "Cost apply", value: data?.enableCostSyncActions ? "enabled" : "disabled" }),
  );
}
