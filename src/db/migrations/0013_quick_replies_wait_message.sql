ALTER TABLE "bot_rules" ADD COLUMN "quick_replies" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "greeting_quick_replies" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "wait_message" text DEFAULT 'Dạ anh/chị chờ em một chút, em đang kiểm tra thông tin ạ.' NOT NULL;