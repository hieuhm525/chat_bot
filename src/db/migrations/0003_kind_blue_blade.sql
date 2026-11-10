UPDATE "users" SET "role" = 'admin' WHERE "role" = 'super_admin';--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_role_check";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("users"."role" in ('admin','owner','agent'));