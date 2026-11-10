ALTER TABLE "users" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "messages_workspace_created_idx" ON "messages" USING btree ("workspace_id","created_at");