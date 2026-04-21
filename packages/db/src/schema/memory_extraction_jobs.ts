import {
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  MemoryExtractionJobAttributionMode,
  MemoryExtractionJobDispatcherKind,
  MemoryExtractionJobHookKind,
  MemoryExtractionJobOperationType,
  MemoryExtractionJobSourceKind,
  MemoryExtractionJobStatus,
} from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { goals } from "./goals.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";

export const memoryExtractionJobs = pgTable(
  "memory_extraction_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    bindingId: uuid("binding_id").notNull(),
    bindingKey: text("binding_key").notNull(),
    operationType: text("operation_type").$type<MemoryExtractionJobOperationType>().notNull(),
    status: text("status").$type<MemoryExtractionJobStatus>().notNull().default("queued"),
    sourceAgentId: uuid("source_agent_id").references(() => agents.id, { onDelete: "set null" }),
    sourceIssueId: uuid("source_issue_id").references(() => issues.id, { onDelete: "set null" }),
    sourceProjectId: uuid("source_project_id").references(() => projects.id, { onDelete: "set null" }),
    sourceGoalId: uuid("source_goal_id").references(() => goals.id, { onDelete: "set null" }),
    sourceHeartbeatRunId: uuid("source_heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    hookKind: text("hook_kind").$type<MemoryExtractionJobHookKind>(),
    providerJobId: text("provider_job_id"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    attributionMode: text("attribution_mode")
      .$type<MemoryExtractionJobAttributionMode>()
      .notNull()
      .default("untracked"),
    costCents: integer("cost_cents").notNull().default(0),
    resultSummary: text("result_summary"),
    errorCode: text("error_code"),
    error: text("error"),
    sourceKind: text("source_kind").$type<MemoryExtractionJobSourceKind>().notNull(),
    sourceRefJson: jsonb("source_ref_json").$type<Record<string, unknown>>(),
    retryOfJobId: uuid("retry_of_job_id").references((): AnyPgColumn => memoryExtractionJobs.id, {
      onDelete: "set null",
    }),
    attemptNumber: integer("attempt_number").notNull().default(1),
    dispatcherKind: text("dispatcher_kind")
      .$type<MemoryExtractionJobDispatcherKind>()
      .notNull()
      .default("in_process"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    usageJson: jsonb("usage_json").$type<Record<string, unknown>>(),
    resultJson: jsonb("result_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusSubmittedIdx: index("memory_extraction_jobs_company_status_submitted_idx").on(
      table.companyId,
      table.status,
      table.submittedAt,
    ),
    companyBindingSubmittedIdx: index("memory_extraction_jobs_company_binding_submitted_idx").on(
      table.companyId,
      table.bindingKey,
      table.submittedAt,
    ),
    companyOperationSubmittedIdx: index("memory_extraction_jobs_company_operation_submitted_idx").on(
      table.companyId,
      table.operationType,
      table.submittedAt,
    ),
    companyIssueSubmittedIdx: index("memory_extraction_jobs_company_issue_submitted_idx").on(
      table.companyId,
      table.sourceIssueId,
      table.submittedAt,
    ),
    companyRunSubmittedIdx: index("memory_extraction_jobs_company_run_submitted_idx").on(
      table.companyId,
      table.sourceHeartbeatRunId,
      table.submittedAt,
    ),
    companyStatusLeaseExpiresIdx: index("memory_extraction_jobs_company_status_lease_expires_idx").on(
      table.companyId,
      table.status,
      table.leaseExpiresAt,
    ),
    dispatcherQueuedIdx: index("memory_extraction_jobs_dispatcher_queued_idx")
      .on(table.dispatcherKind, table.submittedAt)
      .where(sql`${table.status} = 'queued'`),
    retryOfJobIdx: index("memory_extraction_jobs_retry_of_job_idx").on(table.retryOfJobId),
    retryAttemptUq: uniqueIndex("memory_extraction_jobs_retry_attempt_uq")
      .on(table.companyId, table.retryOfJobId, table.attemptNumber)
      .where(sql`${table.retryOfJobId} is not null`),
  }),
);
