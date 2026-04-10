import { describe, expect, it } from "vitest";
import type {
  CompanyDeliverableItem,
  ExecutionWorkspace,
  IssueDocument,
  IssueWorkProduct,
} from "@paperclipai/shared";
import { buildCompanyDeliverables, buildIssueDeliverables } from "../services/issue-deliverables.ts";

function createIssueDocument(overrides: Partial<IssueDocument> = {}): IssueDocument {
  return {
    id: "document-1",
    companyId: "company-1",
    issueId: "issue-1",
    key: "plan",
    title: null,
    format: "markdown",
    body: "# Plan\n\nShip the thing.",
    latestRevisionId: "revision-1",
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: "user-1",
    updatedByAgentId: null,
    updatedByUserId: "user-1",
    createdAt: new Date("2026-04-01T12:00:00.000Z"),
    updatedAt: new Date("2026-04-01T12:00:00.000Z"),
    ...overrides,
  };
}

function createWorkProduct(overrides: Partial<IssueWorkProduct> = {}): IssueWorkProduct {
  return {
    id: "work-product-1",
    companyId: "company-1",
    projectId: "project-1",
    issueId: "issue-1",
    executionWorkspaceId: "workspace-1",
    runtimeServiceId: null,
    type: "pull_request",
    provider: "github",
    externalId: null,
    title: "PR 42",
    url: "https://example.com/pr/42",
    status: "ready_for_review",
    reviewState: "needs_board_review",
    isPrimary: false,
    healthStatus: "unknown",
    summary: "Ready for board review.",
    metadata: null,
    createdByRunId: null,
    createdAt: new Date("2026-04-01T13:00:00.000Z"),
    updatedAt: new Date("2026-04-01T13:00:00.000Z"),
    ...overrides,
  };
}

function createWorkspace(overrides: Partial<ExecutionWorkspace> = {}): ExecutionWorkspace {
  return {
    id: "workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "project-workspace-1",
    sourceIssueId: "issue-1",
    mode: "adapter_managed",
    strategyType: "adapter_managed",
    name: "Remote sandbox",
    status: "active",
    cwd: null,
    repoUrl: "https://github.com/paperclipai/paperclip",
    baseRef: "main",
    branchName: "pap-1280-work-product",
    providerType: "adapter_managed",
    providerRef: "sandbox-42",
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date("2026-04-01T14:00:00.000Z"),
    openedAt: new Date("2026-04-01T12:00:00.000Z"),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    runtimeServices: [
      {
        id: "service-1",
        companyId: "company-1",
        projectId: "project-1",
        projectWorkspaceId: "project-workspace-1",
        executionWorkspaceId: "workspace-1",
        issueId: "issue-1",
        scopeType: "execution_workspace",
        scopeId: "workspace-1",
        serviceName: "Preview",
        status: "running",
        lifecycle: "ephemeral",
        reuseKey: null,
        command: null,
        cwd: null,
        port: null,
        url: "https://preview.example.com",
        provider: "adapter_managed",
        providerRef: "preview-1",
        ownerAgentId: null,
        startedByRunId: null,
        lastUsedAt: new Date("2026-04-01T14:00:00.000Z"),
        startedAt: new Date("2026-04-01T12:30:00.000Z"),
        stoppedAt: null,
        stopPolicy: null,
        healthStatus: "healthy",
        createdAt: new Date("2026-04-01T12:30:00.000Z"),
        updatedAt: new Date("2026-04-01T14:00:00.000Z"),
      },
    ],
    createdAt: new Date("2026-04-01T12:00:00.000Z"),
    updatedAt: new Date("2026-04-01T14:00:00.000Z"),
    ...overrides,
  };
}

describe("buildIssueDeliverables", () => {
  it("pins the plan first in the documents list while choosing the newest document as primary", () => {
    const response = buildIssueDeliverables({
      issue: {
        id: "issue-1",
        projectId: "project-1",
        description: null,
        executionWorkspaceId: null,
        createdAt: new Date("2026-04-01T12:00:00.000Z"),
        updatedAt: new Date("2026-04-01T15:00:00.000Z"),
      },
      workspace: null,
      workProducts: [],
      documents: [
        createIssueDocument(),
        createIssueDocument({
          id: "document-2",
          key: "report",
          title: "Weekly report",
          body: "Latest findings.",
          updatedAt: new Date("2026-04-01T16:00:00.000Z"),
        }),
      ],
      legacyPlanDocument: null,
      attachments: [],
    });

    expect(response.summary.documentCount).toBe(2);
    expect(response.documents[0]?.documentKey).toBe("plan");
    expect(response.primaryItem?.title).toBe("Weekly report");
  });

  it("prefers explicit primary work products and merges artifacts with attachments into files", () => {
    const response = buildIssueDeliverables({
      issue: {
        id: "issue-1",
        projectId: "project-1",
        description: null,
        executionWorkspaceId: "workspace-1",
        createdAt: new Date("2026-04-01T12:00:00.000Z"),
        updatedAt: new Date("2026-04-01T15:00:00.000Z"),
      },
      workspace: createWorkspace(),
      workProducts: [
        createWorkProduct({ isPrimary: true }),
        createWorkProduct({
          id: "work-product-2",
          type: "preview_url",
          title: "Preview deploy",
          provider: "vercel",
          url: "https://preview.example.com",
          healthStatus: "healthy",
          status: "active",
          reviewState: "none",
          updatedAt: new Date("2026-04-01T14:30:00.000Z"),
        }),
        createWorkProduct({
          id: "work-product-3",
          type: "artifact",
          title: "Run report.pdf",
          provider: "paperclip",
          url: "/api/attachments/artifact/content",
          status: "ready_for_review",
          reviewState: "none",
          metadata: { contentType: "application/pdf", byteSize: 2048 },
        }),
      ],
      documents: [],
      legacyPlanDocument: null,
      attachments: [
        {
          id: "attachment-1",
          companyId: "company-1",
          issueId: "issue-1",
          issueCommentId: null,
          assetId: "asset-1",
          provider: "paperclip",
          objectKey: "attachments/build-log.txt",
          contentType: "text/plain",
          byteSize: 512,
          sha256: "abc",
          originalFilename: "build-log.txt",
          createdByAgentId: null,
          createdByUserId: "user-1",
          createdAt: new Date("2026-04-01T15:00:00.000Z"),
          updatedAt: new Date("2026-04-01T15:00:00.000Z"),
        },
      ],
    });

    expect(response.primaryItem?.id).toBe("work-product-1");
    expect(response.summary.previewCount).toBe(1);
    expect(response.summary.fileCount).toBe(2);
    expect(response.workspace?.runtimeServiceCount).toBe(1);
    expect(response.workspace?.runtimeServiceHealth).toBe("healthy");
  });
});

describe("buildCompanyDeliverables", () => {
  it("returns documents, attachments, and work products in one company feed", () => {
    const response = buildCompanyDeliverables({
      issues: [
        {
          id: "issue-1",
          identifier: "PAP-10",
          title: "Write launch plan",
          status: "in_progress",
          projectId: "project-1",
          description: "<plan>Legacy plan body</plan>",
          createdAt: new Date("2026-04-01T09:00:00.000Z"),
          updatedAt: new Date("2026-04-01T15:00:00.000Z"),
        },
        {
          id: "issue-2",
          identifier: "PAP-11",
          title: "Ship preview",
          status: "done",
          projectId: "project-1",
          description: null,
          createdAt: new Date("2026-04-01T10:00:00.000Z"),
          updatedAt: new Date("2026-04-01T16:00:00.000Z"),
        },
      ],
      workProducts: [
        createWorkProduct({
          id: "preview-1",
          issueId: "issue-2",
          type: "preview_url",
          title: "Preview deploy",
          provider: "vercel",
          url: "https://preview.example.com",
          status: "active",
          reviewState: "none",
          healthStatus: "healthy",
          updatedAt: new Date("2026-04-01T17:00:00.000Z"),
        }),
      ],
      documents: [
        createIssueDocument({
          id: "doc-1",
          issueId: "issue-1",
          key: "brief",
          title: "Launch brief",
          body: "Narrative and milestones.",
          updatedAt: new Date("2026-04-01T14:00:00.000Z"),
        }),
      ],
      attachments: [
        {
          id: "attachment-1",
          companyId: "company-1",
          issueId: "issue-2",
          issueCommentId: null,
          assetId: "asset-1",
          provider: "paperclip",
          objectKey: "artifacts/mockup.png",
          contentType: "image/png",
          byteSize: 1024,
          sha256: "abc",
          originalFilename: "mockup.png",
          createdByAgentId: null,
          createdByUserId: "user-1",
          createdAt: new Date("2026-04-01T16:30:00.000Z"),
          updatedAt: new Date("2026-04-01T16:30:00.000Z"),
        },
      ],
    });

    expect(response.summary.totalCount).toBe(4);
    expect(response.summary.documentCount).toBe(2);
    expect(response.summary.fileCount).toBe(1);
    expect(response.summary.previewCount).toBe(1);
    expect(response.summary.issueCount).toBe(2);

    const kinds = response.items.map((item) => item.kind);
    expect(kinds).toEqual(["preview_url", "attachment", "document", "document"]);

    const legacyPlan = response.items.find((item): item is CompanyDeliverableItem => item.id === "legacy-plan:issue-1");
    expect(legacyPlan?.issueIdentifier).toBe("PAP-10");
    expect(legacyPlan?.issueTitle).toBe("Write launch plan");
  });
});
