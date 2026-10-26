-- Initial enterprise schema for SinfonIA.
-- Generated manually to avoid destructive refactors and to keep CI reproducible.

-- UUID generation for defaults.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE "tenant" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'OPERATOR', 'MEMBER');
CREATE TYPE "PracticeStatus" AS ENUM ('CREATED', 'VALIDATED', 'SUBMITTED', 'FAILED', 'COMPLETED');

CREATE TABLE "user" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "email" text NOT NULL,
  "role" "UserRole" NOT NULL DEFAULT 'MEMBER',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "user_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "user_tenant_id_idx" ON "user" ("tenant_id");
CREATE INDEX "user_tenant_id_id_idx" ON "user" ("tenant_id", "id");

CREATE TABLE "practice" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "status" "PracticeStatus" NOT NULL DEFAULT 'CREATED',
  "payload" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "practice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "practice_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "practice_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "practice_tenant_id_idx" ON "practice" ("tenant_id");
CREATE INDEX "practice_tenant_id_user_id_idx" ON "practice" ("tenant_id", "user_id");
CREATE INDEX "practice_tenant_id_status_idx" ON "practice" ("tenant_id", "status");

CREATE TABLE "audit_log" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "user_id" uuid,
  "event_type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "audit_log_tenant_id_idx" ON "audit_log" ("tenant_id");
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" ("created_at");
CREATE INDEX "audit_log_tenant_id_event_type_idx" ON "audit_log" ("tenant_id", "event_type");

