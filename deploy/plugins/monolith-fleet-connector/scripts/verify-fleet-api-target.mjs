#!/usr/bin/env node
import process from "node:process";

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

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function usage() {
  console.error("Usage: node scripts/verify-fleet-api-target.mjs --base-url <url> [--allow-missing]");
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Fleet API base URL is required.");
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function endpoint(baseUrl, path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl}${normalizedPath}`;
}

async function fetchJson(url, options = {}) {
  const startedAt = Date.now();
  const response = await fetch(url, {
    method: "GET",
    headers: options.headers,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    status: response.status,
    ok: response.ok,
    durationMs: Date.now() - startedAt,
    json,
  };
}

async function main() {
  const baseUrlInput = argValue("--base-url") || process.env.FLEET_API_BASE_URL || process.env.MONOLITH_API_URL;
  if (!baseUrlInput || hasFlag("--help") || hasFlag("-h")) {
    usage();
    process.exit(baseUrlInput ? 0 : 2);
  }

  const baseUrl = normalizeBaseUrl(baseUrlInput);
  const allowMissing = hasFlag("--allow-missing");
  const token = process.env.MONOLITH_API_KEY || process.env.FLEET_API_TOKEN || "";
  const headers = token ? { authorization: `Bearer ${token}` } : {};

  const health = await fetchJson(endpoint(baseUrl, "/api/health"), { headers });
  const ready = await fetchJson(endpoint(baseUrl, "/api/ready"), { headers });
  const openapi = await fetchJson(endpoint(baseUrl, "/openapi.json"), { headers });
  const paths = openapi.json && typeof openapi.json === "object" && openapi.json.paths
    ? Object.keys(openapi.json.paths)
    : [];
  const missingPaths = REQUIRED_PATHS.filter((path) => !paths.includes(path));
  const requiredChecksOk = health.ok && ready.ok && openapi.ok;
  const requiredPathsOk = missingPaths.length === 0;

  const result = {
    status: requiredChecksOk && requiredPathsOk ? "ok" : "blocked",
    baseUrl,
    authenticated: Boolean(token),
    health: { status: health.status, ok: health.ok, durationMs: health.durationMs },
    ready: { status: ready.status, ok: ready.ok, durationMs: ready.durationMs },
    openapi: {
      status: openapi.status,
      ok: openapi.ok,
      durationMs: openapi.durationMs,
      pathCount: paths.length,
      requiredPaths: REQUIRED_PATHS,
      missingPaths,
    },
  };

  console.log(JSON.stringify(result, null, 2));

  if (!requiredChecksOk || (!requiredPathsOk && !allowMissing)) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
