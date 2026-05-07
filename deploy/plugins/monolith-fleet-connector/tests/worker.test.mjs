import assert from "node:assert/strict";
import test from "node:test";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";

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
