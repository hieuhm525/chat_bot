ALTER TABLE "workspaces" ADD COLUMN "status" text DEFAULT 'trial' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "plan" text DEFAULT 'trial' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "max_bots" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "max_channels" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "workspaces" SET "status" = 'active';--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_status_check" CHECK ("workspaces"."status" in ('trial','active','suspended','expired'));