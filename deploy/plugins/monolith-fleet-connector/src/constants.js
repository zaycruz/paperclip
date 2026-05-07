export const PLUGIN_ID = "raava.monolith-fleet-connector";
export const PLUGIN_VERSION = "0.1.0";
export const PAGE_ROUTE = "fleet-connector";
export const STATE_NAMESPACE = "fleet-connector";

export const ROUTE_KEYS = Object.freeze({
  overview: "fleet-overview",
  registerExisting: "fleet-register-existing",
  repairLink: "fleet-repair-link",
  syncCosts: "fleet-sync-costs",
});

export const DATA_KEYS = Object.freeze({
  config: "fleet-config",
  overview: "fleet-overview",
  lastOverview: "fleet-last-overview",
});

export const ACTION_KEYS = Object.freeze({
  refreshOverview: "refresh-fleet-overview",
  registerExisting: "register-existing-fleet-agent",
  repairLink: "repair-fleet-agent-link",
  syncCosts: "sync-fleet-costs",
});

export const JOB_KEYS = Object.freeze({
  pollFleetLinks: "poll-fleet-links",
  scheduledCostSync: "scheduled-cost-sync",
});

export const SLOT_IDS = Object.freeze({
  dashboardWidget: "fleet-health-widget",
  sidebarPanel: "fleet-connector-panel",
  page: "fleet-connector-page",
  agentTab: "fleet-agent-tab",
  settingsPage: "fleet-connector-settings",
});

export const EXPORT_NAMES = Object.freeze({
  dashboardWidget: "FleetHealthWidget",
  sidebarPanel: "FleetConnectorPanel",
  page: "FleetConnectorPage",
  agentTab: "AgentFleetTab",
  settingsPage: "FleetConnectorSettings",
});

export const DEFAULT_CONFIG = Object.freeze({
  fleetApiBaseUrl: "",
  fleetApiTokenSecretRef: "",
  tenantIdByCompanyId: Object.freeze({}),
  defaultTenantId: "",
  enableRegisterActions: false,
  enableRepairActions: true,
  enableCostSyncActions: false,
  enableScheduledCostSync: false,
  scheduledCostSyncApply: false,
  scheduledCostSyncHours: 24,
});
