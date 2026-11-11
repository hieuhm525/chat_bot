-- The staff ("agent") role is removed. Agent users nothing points at are deleted (their sessions cascade);
-- agents still referenced by messages, conversations or rules stop the migration so no history is lost silently.
DO $$
DECLARE
  referenced text;
BEGIN
  SELECT string_agg(u.username, ', ') INTO referenced
  FROM "users" u
  WHERE u.role = 'agent'
    AND (EXISTS (SELECT 1 FROM "messages" m WHERE m.sender_user_id = u.id)
      OR EXISTS (SELECT 1 FROM "conversations" c WHERE c.assigned_user_id = u.id)
      OR EXISTS (SELECT 1 FROM "bot_rules" r WHERE r.created_by = u.id));
  IF referenced IS NOT NULL THEN
    RAISE EXCEPTION 'Không bỏ được role agent: user % còn được tin nhắn/hội thoại/rule tham chiếu. Đổi role các user này sang owner hoặc gỡ tham chiếu rồi chạy lại npm run db:migrate.', referenced;
  END IF;
  DELETE FROM "users" WHERE role = 'agent';
END $$;--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_role_check";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("users"."role" in ('admin','owner'));
