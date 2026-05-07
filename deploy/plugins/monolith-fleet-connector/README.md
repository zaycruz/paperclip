# Paperclip Fleet Connector

Paperclip plugin package for bringing Monolith Fleet API state into a Paperclip
instance as a native connector surface.

The connector is intentionally read-mostly by default. It can show linked agent
health, recent sync/cost rollups, deployed routine reconciliation, and guarded
repair actions. Register and cost-apply actions stay opt-in because they mutate
Fleet/Paperclip state.

## Local Install

From a Paperclip development instance with local plugin installs enabled:

```bash
cd /absolute/path/to/monolith/packages/paperclip-fleet-connector
npm install --ignore-scripts
npm install /absolute/path/to/monolith/packages/paperclip-fleet-connector
```

Then enable `raava.monolith-fleet-connector` in Paperclip plugin settings.

The first install step is required for local-path API installs because the
Paperclip worker imports `@paperclipai/plugin-sdk` from the plugin package
itself; Node ESM package resolution does not use the host Paperclip server's
`NODE_PATH`.

This package points `paperclipPlugin` at source JavaScript files so Monolith does
not need a root package workspace or a build dependency.

## Cloud Run Image Bundle

Paperclip's plugin installer can install by npm package name/version or by local
path. A Mac-local path is not usable in Cloud Run, and dynamic npm installs are
not a complete horizontal Cloud Run strategy unless registry auth, install
coordination, and writable storage are also solved. The supported Monolith path
for private deployment is to bake the plugin directory into the Paperclip image
at a stable in-container path, then install that in-container path with
`isLocalPath=true`.

Build the image-ready bundle:

```bash
npm run build:cloud-run-bundle -- --force
```

The default output is:

```text
dist/cloud-run/monolith-fleet-connector
```

The generated bundle contains `README.md`, `package.json`,
`package-lock.json`, `src/`, `paperclip-install-payload.json`, and
`cloud-run-artifact-manifest.json`. Copy that directory into the Paperclip image
and install runtime dependencies in the image build:

```Dockerfile
COPY packages/paperclip-fleet-connector/dist/cloud-run/monolith-fleet-connector /opt/paperclip/plugins/monolith-fleet-connector
RUN cd /opt/paperclip/plugins/monolith-fleet-connector && npm ci --omit=dev --ignore-scripts
```

Then install the baked plugin into Paperclip using the generated
`paperclip-install-payload.json` body:

```json
{
  "packageName": "/opt/paperclip/plugins/monolith-fleet-connector",
  "isLocalPath": true
}
```

On 2026-05-07, the generated bundle was verified with
`npm ci --omit=dev --ignore-scripts` and source imports from the generated
directory. This proves the private image-baked package shape; it does not yet
prove the plugin is installed in the live Cloud Run Paperclip deployment.

## Configuration

Instance config fields:

- `fleetApiBaseUrl`: Fleet API origin, for example
  `https://api.fleetos.raavasolutions.com`.
- `fleetApiTokenSecretRef`: optional Paperclip secret reference for the Fleet API
  bearer token. If blank, requests are sent without `Authorization`, which is
  useful only for local development.
- `tenantIdByCompanyId`: object mapping Paperclip company IDs to Monolith tenant
  IDs.
- `defaultTenantId`: optional fallback tenant for single-company development.
- `enableRepairActions`: defaults to `true`; enables adapter-link repair calls.
- `enableRegisterActions`: defaults to `false`; enables registering an existing
  Fleet agent into Paperclip.
- `enableCostSyncActions`: defaults to `false`; enables non-dry-run cost sync.
- `enableLifecycleActions`: defaults to `false`; enables audited pause/resume
  requests for linked Fleet containers.
- `lifecycleRequireApprovalRef`: defaults to `true`; requires a Paperclip
  approval or Monolith change request reference before pause/resume is allowed.
- `enableBudgetAlerts`: defaults to `true`; writes Paperclip activity alerts
  and metrics for active budget incidents, pending budget approvals, and high
  utilization.
- `budgetAlertUtilizationPercent`: defaults to `90`; utilization threshold for
  warning alerts.
- `enableScheduledCostSync`: defaults to `false`; enables the scheduled
  cost-sync job for configured company mappings.
- `scheduledCostSyncApply`: defaults to `false`; keeps scheduled cost sync in
  dry-run mode unless explicitly enabled. Apply also requires
  `enableCostSyncActions: true`.
- `scheduledCostSyncHours`: defaults to `24`; controls the scheduled lookback
  window.

## Surfaces

- Dashboard widget: Fleet link status, liveness, cost, and routine drift summary.
- Budget status: active Paperclip budget incidents and pending budget approvals
  from the Fleet ops rollup, plus deduplicated activity alerts when budget
  incidents, pending approvals, or threshold utilization are present.
- Sidebar panel/page: company-scoped overview and refresh action.
- Agent detail tab: agent/container link context and guarded repair action.
- API routes:
  - `GET /fleet/overview?companyId=...`
  - `POST /fleet/register-existing`
  - `POST /fleet/repair-link`
  - `POST /fleet/sync-costs`
  - `POST /fleet/lifecycle`
- Scheduled job: `poll-fleet-links` refreshes configured company mappings every
  15 minutes.
- Scheduled job: `scheduled-cost-sync` runs hourly. It is disabled by default,
  dry-runs by default when enabled, and applies only when both
  `scheduledCostSyncApply` and `enableCostSyncActions` are true.

## Safety Model

The connector never stores a Fleet token in plugin state and redacts secret
configuration from data responses. Mutating actions record Paperclip activity
and metrics. Cost sync is dry-run by default at the action/API boundary; applying
cost events requires `enableCostSyncActions: true` plus `dryRun: false`.
Scheduled cost sync has a second guard: the hourly job skips unless
`enableScheduledCostSync` is true, and scheduled apply requires
`scheduledCostSyncApply: true` as well as the normal cost-apply flag.
Budget alerts do not mutate Fleet state; they route rollup-derived incident
state into Paperclip activity and metrics, deduplicated by company and alert
fingerprint.
Pause/resume requests are disabled by default. When enabled, the connector
requires a company-to-tenant mapping, verifies the target container appears in
the company's Fleet ops rollup, requires an approval/change-request reference
by default, queues Fleet's async lifecycle operation, and writes Paperclip
activity plus metrics.

## Local Smoke Evidence

On 2026-05-07, a local trusted Paperclip runtime installed this package through
`POST /api/plugins/install` using `isLocalPath=true`. The smoke verified:

- manifest validation and ready plugin status;
- worker startup and health checks;
- dashboard widget, sidebar panel, page, agent detail tab, and settings UI slot
  registration;
- scheduled `poll-fleet-links` execution;
- manual `poll-fleet-links` trigger execution;
- redacted config bridge data;
- expected worker errors when a Paperclip company has no Monolith tenant
  mapping configured;
- Paperclip's plugin HTTP SSRF guard blocks private `127.0.0.1` Fleet API
  targets;
- a temporary Paperclip company mapped to `tenant-smoke` could read overview
  data, persist `last-overview` state, run dry-run cost sync, and call guarded
  register/repair actions against a public echo endpoint.

## Fleet API Target Preflight

Before configuring a live connector, verify that the selected Monolith Fleet API
host exposes the Paperclip routes the plugin calls:

```bash
npm run verify:fleet-api-target -- --base-url https://api-staging.fleetos.raavasolutions.com
```

The command checks health, readiness, OpenAPI availability, and these required
paths:

- `/api/paperclip/companies/{tenant_id}`
- `/api/paperclip/companies/{tenant_id}/ops-rollup`
- `/api/paperclip/companies/{tenant_id}/routine-reconciliation`
- `/api/paperclip/companies/{tenant_id}/cost-sync`
- `/api/paperclip/agents/{container_id}/register-existing`
- `/api/paperclip/agents/{container_id}/repair`

On 2026-05-07, `https://api-staging.fleetos.raavasolutions.com` returned
healthy/ready responses and OpenAPI exposed all required connector target
routes above. The live Cloud Run Paperclip deployment installed the baked plugin
bundle and loaded it as `ready` in revision `paperclip-00022-sam`.

The live connector was smoke-tested with the IJT Capital Paperclip company
mapped to Monolith tenant `ijt-capital`. The stable Paperclip route
`https://paperclip-lmbn6fkciq-ue.a.run.app` verified:

- plugin config validation returned valid with only the expected anonymous-token
  warning;
- `GET /fleet/overview?companyId=d9375d0b-b255-48eb-ab2d-e9d57836431f`
  returned `status=active`, `linkedAgents=1`, `degradedAgents=0`, and
  `routineSummary.status=in_sync`;
- persisted bridge data for `fleet-last-overview` returned the same IJT tenant
  state;
- the `refresh-fleet-overview` bridge action refreshed the IJT overview
  successfully;
- scheduled `poll-fleet-links` job runs were succeeding every 15 minutes;
- a Paperclip local-encrypted secret backed `fleetApiTokenSecretRef`, redacted
  config showed `fleetApiTokenSecretRefConfigured=true`, and `POST
  /fleet/sync-costs` dry-run reached Fleet API.

On the same date, Fleet API PRs #146-#149 made live cost sync complete for the
IJT mapping. A non-force apply through the connector posted the remaining
three cost buckets with zero failures, moved hosted Paperclip spend from 626 to
657 cents, and a follow-up dry-run returned `status=no_usage` with all 10
known buckets already synced.

Remaining production hardening before calling this fully first-class:

- bake and smoke-test the `scheduled-cost-sync` job in a hosted Paperclip Cloud
  Run revision;
- add signed/HMAC Fleet API auth instead of relying only on bearer token headers;
- live-smoke budget alert activity against a hosted Paperclip company with a
  real budget incident or forced high-utilization rollup;
- live-smoke routine repair actions against a real routine-owning tenant;
- live-smoke audited pause/resume requests against a linked tenant after
  operator approval semantics are configured.
