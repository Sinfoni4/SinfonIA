-- Step 7: WhatsApp channel. A phone number (E.164 digits, as WhatsApp sends it) is linked to a
-- user of a tenant with an invite code, as the Telegram id is.
CREATE TABLE "whatsapp_identity" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "phone_number" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "whatsapp_identity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "whatsapp_identity_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "whatsapp_identity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "whatsapp_identity_tenant_id_phone_number_key" UNIQUE ("tenant_id", "phone_number"),
  CONSTRAINT "whatsapp_identity_user_id_key" UNIQUE ("user_id")
);

CREATE INDEX "whatsapp_identity_phone_number_idx" ON "whatsapp_identity"("phone_number");

-- The linked user must belong to the same tenant (same rule as practice and audit_log).
CREATE TRIGGER whatsapp_identity_user_tenant_match
  BEFORE INSERT OR UPDATE ON "whatsapp_identity"
  FOR EACH ROW EXECUTE FUNCTION enforce_user_tenant_match();
