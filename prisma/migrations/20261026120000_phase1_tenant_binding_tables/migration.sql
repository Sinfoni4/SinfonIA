-- Phase 1 follow-up: tenant invite codes and explicit user-tenant bindings.
-- These tables are part of the DB-backed tenant provisioning flow.

CREATE TABLE "invite_code" (
  "code" TEXT NOT NULL,
  "tenant_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "invite_code_pkey" PRIMARY KEY ("code")
);

CREATE INDEX "invite_code_tenant_id_idx" ON "invite_code"("tenant_id");

ALTER TABLE "invite_code"
  ADD CONSTRAINT "invite_code_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "user_tenant" (
  "id" UUID NOT NULL,
  "user_id" TEXT NOT NULL,
  "tenant_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_tenant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_tenant_user_id_tenant_id_key"
  ON "user_tenant"("user_id", "tenant_id");
CREATE INDEX "user_tenant_user_id_idx" ON "user_tenant"("user_id");
CREATE INDEX "user_tenant_tenant_id_idx" ON "user_tenant"("tenant_id");

ALTER TABLE "user_tenant"
  ADD CONSTRAINT "user_tenant_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
