CREATE TABLE "llm_providers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'openai_compatible' NOT NULL,
	"base_url" text NOT NULL,
	"model" text NOT NULL,
	"api_key_enc" text,
	"key_id" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_check_at" timestamp with time zone,
	"last_check_ok" boolean,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_providers_kind_check" CHECK ("llm_providers"."kind" in ('openai_compatible'))
);
