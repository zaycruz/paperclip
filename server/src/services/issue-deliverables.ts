import type {
  CompanyDeliverableItem,
  CompanyDeliverablesResponse,
  ExecutionWorkspace,
  IssueDeliverableItem,
  IssueDeliverablesResponse,
  IssueDeliverablesWorkspaceSummary,
  IssueDocument,
  IssueWorkProduct,
  LegacyPlanDocument,
} from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { documentService, extractLegacyPlanBody } from "./documents.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { issueService } from "./issues.js";
import { workProductService } from "./work-products.js";

type AttachmentInput = Awaited<ReturnType<ReturnType<typeof issueService>["listAttachments"]>>[number];
type CompanyIssueInput = Pick<
  Awaited<ReturnType<ReturnType<typeof issueService>["list"]>>[number],
  "id" | "identifier" | "title" | "status" | "projectId" | "description" | "createdAt" | "updatedAt"
>;

type IssueInput = {
  id: string;
  projectId: string | null;
  description: string | null;
  executionWorkspaceId: string | null;
  createdAt: Date;
  updatedAt: Date;
};
type LegacyPlanIssueInput = Pick<IssueInput, "id" | "createdAt" | "updatedAt">;

type BuildIssueDeliverablesInput = {
  issue: IssueInput;
  workspace: ExecutionWorkspace | null;
  workProducts: IssueWorkProduct[];
  documents: IssueDocument[];
  legacyPlanDocument: LegacyPlanDocument | null;
  attachments: AttachmentInput[];
};

type BuildCompanyDeliverablesInput = {
  issues: CompanyIssueInput[];
  workProducts: IssueWorkProduct[];
  documents: IssueDocument[];
  attachments: AttachmentInput[];
};

function compareItemsByRecency(a: IssueDeliverableItem, b: IssueDeliverableItem) {
  if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function summarizeMarkdown(body: string, maxLength = 180) {
  const normalized = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function formatDocumentTitle(document: Pick<IssueDocument, "key" | "title">) {
  if (document.key === "plan") return "Plan";
  if (document.title?.trim()) return document.title.trim();
  return document.key
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function toWorkProductItem(product: IssueWorkProduct): IssueDeliverableItem {
  const metadata = product.metadata ?? null;
  const contentType = typeof metadata?.contentType === "string" ? metadata.contentType : null;
  const byteSize = typeof metadata?.byteSize === "number" ? metadata.byteSize : null;
  return {
    id: product.id,
    sourceType: "work_product",
    kind: product.type,
    title: product.title,
    url: product.url,
    summary: product.summary,
    status: product.status ?? null,
    reviewState: product.reviewState ?? null,
    healthStatus: product.healthStatus ?? null,
    provider: product.provider,
    updatedAt: product.updatedAt,
    createdAt: product.createdAt,
    isPrimary: product.isPrimary,
    metadata,
    documentKey: null,
    revisionNumber: null,
    contentType,
    byteSize,
  };
}

function toDocumentItem(document: IssueDocument): IssueDeliverableItem {
  return {
    id: document.id,
    sourceType: "document",
    kind: "document",
    title: formatDocumentTitle(document),
    url: `#document-${encodeURIComponent(document.key)}`,
    summary: summarizeMarkdown(document.body),
    status: null,
    reviewState: null,
    healthStatus: null,
    provider: "paperclip",
    updatedAt: document.updatedAt,
    createdAt: document.createdAt,
    isPrimary: false,
    metadata: null,
    documentKey: document.key,
    revisionNumber: document.latestRevisionNumber,
    contentType: "text/markdown",
    byteSize: null,
  };
}

function toLegacyPlanItem(issue: LegacyPlanIssueInput, legacyPlanDocument: LegacyPlanDocument): IssueDeliverableItem {
  return {
    id: `legacy-plan:${issue.id}`,
    sourceType: "legacy_plan_document",
    kind: "document",
    title: "Plan",
    url: "#document-plan",
    summary: summarizeMarkdown(legacyPlanDocument.body),
    status: null,
    reviewState: null,
    healthStatus: null,
    provider: "paperclip",
    updatedAt: issue.updatedAt,
    createdAt: issue.createdAt,
    isPrimary: false,
    metadata: { source: legacyPlanDocument.source },
    documentKey: legacyPlanDocument.key,
    revisionNumber: null,
    contentType: "text/markdown",
    byteSize: null,
  };
}

function toAttachmentItem(attachment: AttachmentInput): IssueDeliverableItem {
  return {
    id: attachment.id,
    sourceType: "attachment",
    kind: "attachment",
    title: attachment.originalFilename ?? attachment.objectKey,
    url: `/api/attachments/${attachment.id}/content`,
    summary: null,
    status: null,
    reviewState: null,
    healthStatus: null,
    provider: attachment.provider,
    updatedAt: attachment.updatedAt,
    createdAt: attachment.createdAt,
    isPrimary: false,
    metadata: null,
    documentKey: null,
    revisionNumber: null,
    contentType: attachment.contentType,
    byteSize: attachment.byteSize,
  };
}

function toCompanyDeliverableItem(
  item: IssueDeliverableItem,
  issue: CompanyIssueInput,
): CompanyDeliverableItem {
  return {
    ...item,
    issueId: issue.id,
    issueIdentifier: issue.identifier ?? null,
    issueTitle: issue.title,
    issueStatus: issue.status,
    projectId: issue.projectId,
  };
}

function summarizeRuntimeServiceHealth(
  workspace: ExecutionWorkspace | null,
): IssueDeliverablesWorkspaceSummary["runtimeServiceHealth"] {
  if (!workspace?.runtimeServices || workspace.runtimeServices.length === 0) return null;
  if (workspace.runtimeServices.some((service) => service.healthStatus === "unhealthy" || service.status === "failed")) {
    return "unhealthy";
  }
  if (workspace.runtimeServices.every((service) => service.healthStatus === "healthy" || service.status === "running")) {
    return "healthy";
  }
  return "unknown";
}

function summarizeWorkspace(workspace: ExecutionWorkspace | null): IssueDeliverablesWorkspaceSummary | null {
  if (!workspace) return null;
  return {
    id: workspace.id,
    projectId: workspace.projectId,
    projectWorkspaceId: workspace.projectWorkspaceId,
    name: workspace.name,
    mode: workspace.mode,
    status: workspace.status,
    providerType: workspace.providerType,
    branchName: workspace.branchName,
    baseRef: workspace.baseRef,
    lastUsedAt: workspace.lastUsedAt,
    runtimeServiceCount: workspace.runtimeServices?.length ?? 0,
    runtimeServiceHealth: summarizeRuntimeServiceHealth(workspace),
    runtimeServices: (workspace.runtimeServices ?? []).map((service) => ({
      id: service.id,
      serviceName: service.serviceName,
      status: service.status,
      healthStatus: service.healthStatus,
      url: service.url,
    })),
  };
}

function sortDocuments(items: IssueDeliverableItem[]) {
  return [...items].sort((a, b) => {
    if (a.documentKey === "plan" && b.documentKey !== "plan") return -1;
    if (a.documentKey !== "plan" && b.documentKey === "plan") return 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

function pickPrimaryItem(groups: {
  workProducts: IssueWorkProduct[];
  previews: IssueDeliverableItem[];
  pullRequests: IssueDeliverableItem[];
  documents: IssueDeliverableItem[];
  files: IssueDeliverableItem[];
}) {
  const explicitPrimary = [...groups.workProducts]
    .filter((product) => product.isPrimary)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
  if (explicitPrimary) return toWorkProductItem(explicitPrimary);

  const preview = [...groups.previews]
    .filter((item) => item.kind === "preview_url")
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
  if (preview) return preview;

  const pullRequest = [...groups.pullRequests].sort(compareItemsByRecency)[0];
  if (pullRequest) return pullRequest;

  const document = [...groups.documents]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
  if (document) return document;

  return [...groups.files].sort(compareItemsByRecency)[0] ?? null;
}

export function buildIssueDeliverables(input: BuildIssueDeliverablesInput): IssueDeliverablesResponse {
  const workspace = summarizeWorkspace(input.workspace);
  const workProductItems = input.workProducts.map(toWorkProductItem);
  const previews = workProductItems
    .filter((item) => item.kind === "preview_url" || item.kind === "runtime_service")
    .sort(compareItemsByRecency);
  const pullRequests = workProductItems
    .filter((item) => item.kind === "pull_request")
    .sort(compareItemsByRecency);
  const branches = workProductItems
    .filter((item) => item.kind === "branch")
    .sort(compareItemsByRecency);
  const commits = workProductItems
    .filter((item) => item.kind === "commit")
    .sort(compareItemsByRecency);

  const documentItems = [
    ...workProductItems.filter((item) => item.kind === "document"),
    ...input.documents.map(toDocumentItem),
    ...(input.legacyPlanDocument ? [toLegacyPlanItem(input.issue, input.legacyPlanDocument)] : []),
  ];

  const fileItems = [
    ...workProductItems.filter((item) => item.kind === "artifact"),
    ...input.attachments.map(toAttachmentItem),
  ].sort(compareItemsByRecency);

  const primaryItem = pickPrimaryItem({
    workProducts: input.workProducts,
    previews,
    pullRequests,
    documents: documentItems,
    files: fileItems,
  });

  return {
    workspace,
    summary: {
      hasAny: Boolean(
        workspace ||
        previews.length ||
        pullRequests.length ||
        branches.length ||
        commits.length ||
        documentItems.length ||
        fileItems.length
      ),
      previewCount: previews.length,
      pullRequestCount: pullRequests.length,
      branchCount: branches.length,
      commitCount: commits.length,
      documentCount: documentItems.length,
      fileCount: fileItems.length,
      workspaceMode: workspace?.mode ?? null,
      workspaceStatus: workspace?.status ?? null,
      previewHealth: previews.length === 1 ? previews[0]?.healthStatus ?? null : null,
      pullRequestStatus: pullRequests.length === 1 ? pullRequests[0]?.status ?? null : null,
      pullRequestReviewState: pullRequests.length === 1 ? pullRequests[0]?.reviewState ?? null : null,
    },
    primaryItem,
    previews,
    pullRequests,
    branches,
    commits,
    documents: sortDocuments(documentItems),
    files: fileItems,
  };
}

export function buildCompanyDeliverables(input: BuildCompanyDeliverablesInput): CompanyDeliverablesResponse {
  const issueMap = new Map<string, CompanyIssueInput>();
  for (const issue of input.issues) {
    issueMap.set(issue.id, issue);
  }

  const explicitPlanIssueIds = new Set(
    input.documents
      .filter((document) => document.key === "plan")
      .map((document) => document.issueId),
  );

  const items: CompanyDeliverableItem[] = [];
  for (const product of input.workProducts) {
    const issue = issueMap.get(product.issueId);
    if (!issue) continue;
    items.push(toCompanyDeliverableItem(toWorkProductItem(product), issue));
  }

  for (const document of input.documents) {
    const issue = issueMap.get(document.issueId);
    if (!issue) continue;
    items.push(toCompanyDeliverableItem(toDocumentItem(document), issue));
  }

  for (const attachment of input.attachments) {
    const issue = issueMap.get(attachment.issueId);
    if (!issue) continue;
    items.push(toCompanyDeliverableItem(toAttachmentItem(attachment), issue));
  }

  for (const issue of input.issues) {
    if (explicitPlanIssueIds.has(issue.id)) continue;
    const legacyPlanBody = extractLegacyPlanBody(issue.description);
    if (!legacyPlanBody) continue;
    items.push(
      toCompanyDeliverableItem(
        toLegacyPlanItem(issue, {
          key: "plan",
          body: legacyPlanBody,
          source: "issue_description",
        }),
        issue,
      ),
    );
  }

  const sortedItems = [...items].sort(compareItemsByRecency);
  const issueIds = new Set<string>();
  let primaryCount = 0;
  let previewCount = 0;
  let pullRequestCount = 0;
  let branchCount = 0;
  let commitCount = 0;
  let documentCount = 0;
  let fileCount = 0;

  for (const item of sortedItems) {
    issueIds.add(item.issueId);
    if (item.isPrimary) primaryCount += 1;
    if (item.kind === "preview_url" || item.kind === "runtime_service") previewCount += 1;
    else if (item.kind === "pull_request") pullRequestCount += 1;
    else if (item.kind === "branch") branchCount += 1;
    else if (item.kind === "commit") commitCount += 1;
    else if (item.kind === "document") documentCount += 1;
    else fileCount += 1;
  }

  return {
    items: sortedItems,
    summary: {
      totalCount: sortedItems.length,
      issueCount: issueIds.size,
      primaryCount,
      previewCount,
      pullRequestCount,
      branchCount,
      commitCount,
      documentCount,
      fileCount,
    },
  };
}

export function issueDeliverableService(db: Db) {
  const issuesSvc = issueService(db);
  const workProductsSvc = workProductService(db);
  const documentsSvc = documentService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db);

  return {
    listForCompany: async (companyId: string) => {
      const [issues, workProducts, documents, attachments] = await Promise.all([
        issuesSvc.list(companyId),
        workProductsSvc.listForCompany(companyId),
        documentsSvc.listCompanyIssueDocuments(companyId).then((rows) => rows as IssueDocument[]),
        issuesSvc.listAttachmentsForCompany(companyId),
      ]);

      return buildCompanyDeliverables({
        issues: issues.map((issue) => ({
          id: issue.id,
          identifier: issue.identifier ?? null,
          title: issue.title,
          status: issue.status,
          projectId: issue.projectId,
          description: issue.description,
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
        })),
        workProducts,
        documents,
        attachments,
      });
    },

    getForIssue: async (issue: IssueInput) => {
      const legacyPlanBody = extractLegacyPlanBody(issue.description);
      const [workspace, workProducts, documents, attachments] = await Promise.all([
        issue.executionWorkspaceId ? executionWorkspacesSvc.getById(issue.executionWorkspaceId) : Promise.resolve(null),
        workProductsSvc.listForIssue(issue.id),
        documentsSvc.listIssueDocuments(issue.id).then((rows) => rows as IssueDocument[]),
        issuesSvc.listAttachments(issue.id),
      ]);

      return buildIssueDeliverables({
        issue,
        workspace,
        workProducts,
        documents,
        legacyPlanDocument: legacyPlanBody
          ? {
              key: "plan",
              body: legacyPlanBody,
              source: "issue_description",
            }
          : null,
        attachments,
      });
    },
  };
}
