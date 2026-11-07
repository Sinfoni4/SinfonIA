-- AGX-06: requests for a document (integration) on a practice. Staff of the organization, or of
-- an organization working through a delegation, ask for a document; the holder of the practice
-- hears it in chat and answers by sending the file, which fulfils the request. Additive only.

CREATE TYPE "DocumentRequestStatus" AS ENUM ('OPEN', 'FULFILLED', 'CANCELLED');

CREATE TABLE "document_request" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "practice_id" UUID NOT NULL,
    -- An expected document of the practice's type (AGX-05), or null for anything else.
    "expected_key" TEXT,
    "message" TEXT NOT NULL,
    "due_date" DATE,
    "status" "DocumentRequestStatus" NOT NULL DEFAULT 'OPEN',
    "requested_by" UUID,
    -- The organization of who asked, where they hear the answer (another one through a delegation).
    "requester_org_id" UUID,
    "grant_id" UUID,
    "fulfilled_attachment_id" UUID,
    "fulfilled_by" UUID,
    "fulfilled_at" TIMESTAMPTZ,
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "document_request_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "document_request_tenant_id_status_created_at_idx"
  ON "document_request"("tenant_id", "status", "created_at");

CREATE INDEX "document_request_practice_id_status_idx"
  ON "document_request"("practice_id", "status");

ALTER TABLE "document_request" ADD CONSTRAINT "document_request_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "document_request" ADD CONSTRAINT "document_request_practice_id_fkey"
  FOREIGN KEY ("practice_id") REFERENCES "practice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
