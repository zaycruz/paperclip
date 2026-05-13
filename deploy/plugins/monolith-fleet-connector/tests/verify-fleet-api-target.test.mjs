import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const REQUIRED_PATHS = [
  "/api/paperclip/companies/{tenant_id}",
  "/api/paperclip/companies/{tenant_id}/ops-rollup",
  "/api/paperclip/companies/{tenant_id}/routine-reconciliation",
  "/api/paperclip/companies/{tenant_id}/routine-repair",
  "/api/paperclip/companies/{tenant_id}/cost-sync",
  "/api/fleet-manager/actions",
  "/api/paperclip/agents/{container_id}/register-existing",
  "/api/paperclip/agents/{container_id}/repair",
];

const scriptPath = fileURLToPath(new URL("../scripts/verify-fleet-api-target.mjs", import.meta.url));

function startFleetApiStub(handler) {
  const server = http.createServer((request, response) => {
    handler(request, response);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function fleetApiHandler({ healthStatus = 200, readyStatus = 200, paths = REQUIRED_PATHS } = {}) {
  return (request, response) => {
    if (request.url === "/api/health") {
      json(response, healthStatus, { status: healthStatus === 200 ? "ok" : "error" });
      return;
    }
    if (request.url === "/api/ready") {
      json(response, readyStatus, { status: readyStatus === 200 ? "ready" : "blocked" });
      return;
    }
    if (request.url === "/openapi.json") {
      json(response, 200, {
        openapi: "3.0.0",
        paths: Object.fromEntries(paths.map((path) => [path, {}])),
      });
      return;
    }
    json(response, 404, { error: "not_found" });
  };
}

function runVerifier(baseUrl, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, "--base-url", baseUrl, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (status, extraStderr = "") => {
      if (settled) return;
      settled = true;
      resolve({
        status,
        stdout,
        stderr: extraStderr ? `${stderr}${stderr ? "\n" : ""}${extraStderr}` : stderr,
      });
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish(1, error instanceof Error ? error.message : String(error));
    });
    child.on("close", (status) => {
      finish(status);
    });
  });
}

function parseVerifierResult(result) {
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

describe("verify-fleet-api-target", () => {
  const servers = [];

  after(async () => {
    await Promise.all(servers.map((server) => server.close()));
  });

  async function withServer(handler) {
    const server = await startFleetApiStub(handler);
    servers.push(server);
    return server;
  }

  it("passes when required probes and OpenAPI paths are healthy", async () => {
    const server = await withServer(fleetApiHandler());

    const result = await runVerifier(server.baseUrl);
    const payload = parseVerifierResult(result);

    assert.equal(result.status, 0);
    assert.equal(payload.status, "ok");
    assert.equal(payload.health.ok, true);
    assert.equal(payload.ready.ok, true);
    assert.equal(payload.openapi.ok, true);
    assert.deepEqual(payload.openapi.missingPaths, []);
  });

  it("fails when a required health probe is unhealthy even if paths match", async () => {
    const server = await withServer(fleetApiHandler({ healthStatus: 500 }));

    const result = await runVerifier(server.baseUrl);
    const payload = parseVerifierResult(result);

    assert.equal(result.status, 1);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.health.ok, false);
    assert.deepEqual(payload.openapi.missingPaths, []);
  });

  it("keeps allow-missing scoped to path gaps only", async () => {
    const server = await withServer(fleetApiHandler({ paths: REQUIRED_PATHS.slice(0, 1) }));

    const result = await runVerifier(server.baseUrl, ["--allow-missing"]);
    const payload = parseVerifierResult(result);

    assert.equal(result.status, 0);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.health.ok, true);
    assert.equal(payload.ready.ok, true);
    assert.equal(payload.openapi.ok, true);
    assert.deepEqual(payload.openapi.missingPaths, REQUIRED_PATHS.slice(1));
  });
});
