import { createHmac } from "node:crypto";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber, parseObject } from "../utils.js";

function buildSignedHeaders(
  config: Record<string, unknown>,
  body: string,
  runId: string,
): Record<string, string> {
  const hmacSecret = asString(config.hmacSecret, "");
  if (!hmacSecret) return {};

  const timestampHeader = asString(config.hmacTimestampHeader, "x-paperclip-timestamp");
  const signatureHeader = asString(config.hmacSignatureHeader, "x-paperclip-signature");
  const idempotencyHeader = asString(config.idempotencyHeader, "x-paperclip-idempotency-key");
  const idempotencyKey = asString(config.idempotencyKey, runId);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", hmacSecret)
    .update(`${timestamp}.${body}`)
    .digest("hex");

  return {
    [timestampHeader]: timestamp,
    [signatureHeader]: `sha256=${signature}`,
    [idempotencyHeader]: idempotencyKey,
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context } = ctx;
  const url = asString(config.url, "");
  if (!url) throw new Error("HTTP adapter missing url");

  const method = asString(config.method, "POST");
  const timeoutMs = asNumber(config.timeoutMs, 0);
  const headers = parseObject(config.headers) as Record<string, string>;
  const payloadTemplate = parseObject(config.payloadTemplate);
  const body = { ...payloadTemplate, agentId: agent.id, runId, context };
  const bodyJson = JSON.stringify(body);
  const signedHeaders = buildSignedHeaders(config, bodyJson, runId);

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        ...headers,
        ...signedHeaders,
      },
      body: bodyJson,
      ...(timer ? { signal: controller.signal } : {}),
    });

    if (!res.ok) {
      throw new Error(`HTTP invoke failed with status ${res.status}`);
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: `HTTP ${method} ${url}`,
    };
  } catch (err) {
    if (timer && err instanceof Error && err.name === "AbortError") {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `HTTP ${method} ${url} timed out after ${timeoutMs}ms`,
        errorCode: "timeout",
      };
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
