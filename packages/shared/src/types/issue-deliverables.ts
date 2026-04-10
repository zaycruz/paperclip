import type { ExecutionWorkspaceProviderType, ExecutionWorkspaceStatus } from "./workspace-runtime.js";
import type { IssueWorkProductType } from "./work-product.js";

export type IssueDeliverableSourceType =
  | "work_product"
  | "document"
  | "attachment"
  | "legacy_plan_document";

export type IssueDeliverableKind = IssueWorkProductType | "attachment";

export interface IssueDeliverableItem {
  id: string;
  sourceType: IssueDeliverableSourceType;
  kind: IssueDeliverableKind;
  title: string;
  url: string | null;
  summary: string | null;
  status: string | null;
  reviewState: string | null;
  healthStatus: "unknown" | "healthy" | "unhealthy" | null;
  provider: string | null;
  updatedAt: Date;
  createdAt: Date | null;
  isPrimary: boolean;
  metadata: Record<string, unknown> | null;
  documentKey: string | null;
  revisionNumber: number | null;
  contentType: string | null;
  byteSize: number | null;
}

export interface IssueDeliverablesRuntimeServiceSummary {
  id: string;
  serviceName: string;
  status: string;
  healthStatus: "unknown" | "healthy" | "unhealthy";
  url: string | null;
}

export interface IssueDeliverablesWorkspaceSummary {
  id: string;
  projectId: string;
  projectWorkspaceId: string | null;
  name: string;
  mode: string;
  status: ExecutionWorkspaceStatus;
  providerType: ExecutionWorkspaceProviderType;
  branchName: string | null;
  baseRef: string | null;
  lastUsedAt: Date;
  runtimeServiceCount: number;
  runtimeServiceHealth: "unknown" | "healthy" | "unhealthy" | null;
  runtimeServices: IssueDeliverablesRuntimeServiceSummary[];
}

export interface IssueDeliverablesSummary {
  hasAny: boolean;
  previewCount: number;
  pullRequestCount: number;
  branchCount: number;
  commitCount: number;
  documentCount: number;
  fileCount: number;
  workspaceMode: string | null;
  workspaceStatus: ExecutionWorkspaceStatus | null;
  previewHealth: "unknown" | "healthy" | "unhealthy" | null;
  pullRequestStatus: string | null;
  pullRequestReviewState: string | null;
}

export interface IssueDeliverablesResponse {
  workspace: IssueDeliverablesWorkspaceSummary | null;
  summary: IssueDeliverablesSummary;
  primaryItem: IssueDeliverableItem | null;
  previews: IssueDeliverableItem[];
  pullRequests: IssueDeliverableItem[];
  branches: IssueDeliverableItem[];
  commits: IssueDeliverableItem[];
  documents: IssueDeliverableItem[];
  files: IssueDeliverableItem[];
}

export interface CompanyDeliverableItem extends IssueDeliverableItem {
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  issueStatus: string;
  projectId: string | null;
}

export interface CompanyDeliverablesSummary {
  totalCount: number;
  issueCount: number;
  primaryCount: number;
  previewCount: number;
  pullRequestCount: number;
  branchCount: number;
  commitCount: number;
  documentCount: number;
  fileCount: number;
}

export interface CompanyDeliverablesResponse {
  items: CompanyDeliverableItem[];
  summary: CompanyDeliverablesSummary;
}
