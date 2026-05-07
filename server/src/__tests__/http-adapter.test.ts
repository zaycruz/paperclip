import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "../adapters/http/execute.js";
import type { AdapterExecutionContext } from "../adapters/types.js";

function buildContext(config: Record<string, unknown>): AdapterExecutionContext {
  return {
    runId: "run-123",
    agent: {
      id: "agent-123",
      companyId: "company-123",
      name: "HTTP Agent",
      adapterType: "http",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {
      taskId: "task-123",
      issueId: "issue-123",
      wakeReason: "issue_assigned",
      issueIds: ["issue-123"],
    },
    onLog: async () => {},
  };
}

describe("http adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps static headers when HMAC signing is not configured", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 202 }) as Response);
    vi.stubGlobal("fetch", fetchMock);

    await execute(buildContext({
      url: "https://agent.example/paperclip/wake",
      headers: { "x-paperclip-gateway-secret": "shared" },
    }));

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      "x-paperclip-gateway-secret": "shared",
    });
    expect(init.headers).not.toHaveProperty("x-paperclip-signature");
  });

  it("adds HMAC timestamp, signature, and idempotency headers when configured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-07T13:00:00Z"));
    const fetchMock = vi.fn(async () => ({ ok: true, status: 202 }) as Response);
    vi.stubGlobal("fetch", fetchMock);

    await execute(buildContext({
      url: "https://agent.example/paperclip/wake",
      headers: { "x-paperclip-gateway-secret": "shared" },
      hmacSecret: "signed-secret",
    }));

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = String(init.body);
    const expectedTimestamp = String(Math.floor(new Date("2026-05-07T13:00:00Z").getTime() / 1000));
    const expectedSignature = createHmac("sha256", "signed-secret")
      .update(`${expectedTimestamp}.${body}`)
      .digest("hex");

    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      "x-paperclip-gateway-secret": "shared",
      "x-paperclip-timestamp": expectedTimestamp,
      "x-paperclip-signature": `sha256=${expectedSignature}`,
      "x-paperclip-idempotency-key": "run-123",
    });
  });
});
