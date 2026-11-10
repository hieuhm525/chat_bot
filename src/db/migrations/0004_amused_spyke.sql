ALTER TABLE "conversations" ADD COLUMN "bot_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "message_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_user_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "bot_id" uuid;--> statement-breakpoint
UPDATE "conversations" SET "bot_id" = "channels"."bot_id" FROM "channels" WHERE "channels"."id" = "conversations"."channel_id";--> statement-breakpoint
UPDATE "conversations" SET "message_count" = (SELECT count(*) FROM "messages" WHERE "messages"."conversation_id" = "conversations"."id");--> statement-breakpoint
UPDATE "messages" SET "bot_id" = (SELECT "bots"."id" FROM "bots" WHERE "bots"."workspace_id" = "messages"."workspace_id" ORDER BY "bots"."created_at" LIMIT 1) WHERE "messages"."sender_type" = 'bot';--> statement-breakpoint
UPDATE "messages" SET "sender_user_id" = COALESCE(
  (SELECT "conversations"."assigned_user_id" FROM "conversations" WHERE "conversations"."id" = "messages"."conversation_id"),
  (SELECT "users"."id" FROM "users" WHERE "users"."workspace_id" = "messages"."workspace_id" AND "users"."role" = 'owner' ORDER BY "users"."created_at" LIMIT 1)
) WHERE "messages"."sender_type" = 'agent';--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_check" CHECK ("messages"."sender_type" <> 'agent' or "messages"."sender_user_id" is not null or "messages"."metadata"->>'via' = 'page_inbox');--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_bot_check" CHECK ("messages"."sender_type" <> 'bot' or "messages"."bot_id" is not null);