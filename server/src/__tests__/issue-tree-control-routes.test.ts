import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockTreeControlService = vi.hoisted(() => ({
  preview: vi.fn(),
  createHold: vi.fn(),
  getHold: vi.fn(),
  releaseHold: vi.fn(),
  cancelUnclaimedWakeupsForTree: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockHeartbeatService = vi.hoisted(() => ({
  cancelRun: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  heartbeatService: () => mockHeartbeatService,
  issueService: () => mockIssueService,
  issueTreeControlService: () => mockTreeControlService,
  logActivity: mockLogActivity,
}));

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { issueTreeControlRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issue-tree-control.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueTreeControlRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("issue tree control routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-2",
    });
    mockTreeControlService.cancelUnclaimedWakeupsForTree.mockResolvedValue([]);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
  });

  it("rejects cross-company preview requests before calling the preview service", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/tree-control/preview")
      .send({ mode: "pause" });

    expect(res.status).toBe(403);
    expect(mockTreeControlService.preview).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("requires board access for hold creation", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "company-2",
      runId: null,
      source: "api_key",
    });

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/tree-holds")
      .send({ mode: "pause" });

    expect(res.status).toBe(403);
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockTreeControlService.createHold).not.toHaveBeenCalled();
  });

  it("cancels active descendant runs when creating a pause hold", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-2"],
      source: "session",
      isInstanceAdmin: false,
    });
    mockTreeControlService.createHold.mockResolvedValue({
      hold: {
        id: "33333333-3333-4333-8333-333333333333",
        mode: "pause",
        reason: "pause subtree",
      },
      preview: {
        mode: "pause",
        totals: { affectedIssues: 1 },
        warnings: [],
        activeRuns: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            issueId: "11111111-1111-4111-8111-111111111111",
          },
        ],
      },
    });

    const res = await request(app)
      .post("/api/issues/11111111-1111-4111-8111-111111111111/tree-holds")
      .send({ mode: "pause", reason: "pause subtree" });

    expect(res.status).toBe(201);
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("44444444-4444-4444-8444-444444444444");
    expect(mockTreeControlService.cancelUnclaimedWakeupsForTree).toHaveBeenCalledWith(
      "company-2",
      "11111111-1111-4111-8111-111111111111",
      "Cancelled because an active subtree pause hold was created",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.tree_hold_run_interrupted",
        entityId: "44444444-4444-4444-8444-444444444444",
      }),
    );
  });
});
