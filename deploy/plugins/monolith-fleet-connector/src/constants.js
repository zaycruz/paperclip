export const PLUGIN_ID = "raava.monolith-fleet-connector";
export const PLUGIN_VERSION = "0.1.0";
export const PAGE_ROUTE = "fleet-connector";
export const STATE_NAMESPACE = "fleet-connector";

export const ROUTE_KEYS = Object.freeze({
  overview: "fleet-overview",
  linkHealth: "fleet-link-health",
  routineAuthorityPreview: "fleet-routine-authority-preview",
  managedRoutineReconciliation: "fleet-managed-routine-reconciliation",
  dryRunRoutineMirrorStatus: "fleet-dry-run-routine-mirror-status",
  approvedRoutineMirror: "fleet-approved-routine-mirror",
  registerExisting: "fleet-register-existing",
  repairLink: "fleet-repair-link",
  routineRepair: "fleet-routine-repair",
  syncCosts: "fleet-sync-costs",
  lifecycle: "fleet-lifecycle",
  reconcileManagedResources: "fleet-reconcile-managed-resources",
});

export const DATA_KEYS = Object.freeze({
  config: "fleet-config",
  overview: "fleet-overview",
  lastOverview: "fleet-last-overview",
  managedResources: "fleet-managed-resources",
  ijtManagedRoutines: "ijt-managed-routines",
});

export const ACTION_KEYS = Object.freeze({
  refreshOverview: "refresh-fleet-overview",
  routineAuthorityPreview: "routine-authority-preview",
  managedRoutineReconciliation: "managed-routine-reconciliation",
  dryRunRoutineMirrorStatus: "dry-run-routine-mirror-status",
  approvedRoutineMirror: "approved-routine-mirror",
  registerExisting: "register-existing-fleet-agent",
  repairLink: "repair-fleet-agent-link",
  routineRepair: "repair-fleet-routines",
  syncCosts: "sync-fleet-costs",
  lifecycle: "request-fleet-lifecycle",
  reconcileManagedResources: "reconcile-fleet-managed-resources",
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
  enableRepairActions: false,
  enableRoutineRepairActions: false,
  routineRepairRequireApprovalRef: true,
  enableRoutineMirrorActions: false,
  routineMirrorRequireApprovalRef: true,
  enableCostSyncActions: false,
  enableLifecycleActions: false,
  lifecycleRequireApprovalRef: true,
  enableBudgetAlerts: true,
  budgetAlertUtilizationPercent: 90,
  enableScheduledCostSync: false,
  scheduledCostSyncApply: false,
  scheduledCostSyncHours: 24,
});

export const MANAGED_RESOURCE_KEYS = Object.freeze({
  agent: "fleet-governance-operator",
  project: "monolith-fleet-operations",
  routine: "fleet-governance-review",
});

export const IJT_MANAGED_ROUTINE_SET = Object.freeze({
  setKey: "ijt-capital-managed-outcomes",
  companySlug: "ijt-capital",
  tenantId: "ijt-capital",
  routines: Object.freeze([
    Object.freeze({
      routineKey: "ijt-capital.coo.daily-operating-brief",
      title: "Daily operating brief",
      role: "COO",
      assigneeRuntimeRef: "raava-ijt-capital-aurum-coo",
      description: "Prepare the daily operating brief from Paperclip-owned company state and Fleet/Hermes runtime evidence.",
    }),
    Object.freeze({
      routineKey: "ijt-capital.coo.routine-reconciliation",
      title: "Routine reconciliation",
      role: "COO",
      assigneeRuntimeRef: "raava-ijt-capital-aurum-coo",
      description: "Compare Paperclip managed routine keys, Fleet-linked assignees, and Hermes routine contracts without matching on mutable titles.",
    }),
    Object.freeze({
      routineKey: "ijt-capital.coo.fleet-link-health",
      title: "Fleet link health",
      role: "COO",
      assigneeRuntimeRef: "raava-ijt-capital-aurum-coo",
      description: "Check Fleet runtime identity, Hermes adapter reachability, Paperclip node linkage, and local-only cron drift.",
    }),
  ]),
});
