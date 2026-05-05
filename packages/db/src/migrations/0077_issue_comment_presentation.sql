ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "author_type" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "presentation" jsonb;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
