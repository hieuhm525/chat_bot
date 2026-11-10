ALTER TABLE "bots" ADD COLUMN "system_prompt" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "deleted_at" timestamp with time zone;