-- Step 8: conversation memory of chat users (Telegram, WhatsApp) moved from process memory to the
-- database, so it survives restarts and is shared by several instances.
CREATE TABLE "conversation_state" (
  "user_id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  -- Last practice the user worked on ("completa quella").
  "last_practice_id" uuid,
  -- When the welcome message was shown.
  "onboarded_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "conversation_state_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "conversation_state_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "conversation_state_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "conversation_state_tenant_id_idx" ON "conversation_state"("tenant_id");

CREATE TRIGGER conversation_state_user_tenant_match
  BEFORE INSERT OR UPDATE ON "conversation_state"
  FOR EACH ROW EXECUTE FUNCTION enforce_user_tenant_match();
