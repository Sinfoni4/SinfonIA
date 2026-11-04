-- «Parla con un operatore» (docs/PROGETTO_ARCHITETTURA_3_LIVELLI.md §4.3, decision H10): a request
-- from the chat, seen and handled in the dashboard, without live chat. Only the topic chosen with
-- a button is kept, never free text: saving messages waits for H5. Additive only.

CREATE TYPE "AssistanceTopic" AS ENUM ('PRACTICE', 'DOCUMENT', 'DEADLINE', 'OTHER');

CREATE TYPE "AssistanceStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'CLOSED');

CREATE TABLE "assistance_request" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "topic" "AssistanceTopic" NOT NULL,
    "channel" "ChannelType" NOT NULL,
    "status" "AssistanceStatus" NOT NULL DEFAULT 'OPEN',
    "taken_by" UUID,
    "taken_at" TIMESTAMPTZ,
    "closed_by" UUID,
    "closed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "assistance_request_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assistance_request_tenant_id_status_created_at_idx"
  ON "assistance_request"("tenant_id", "status", "created_at");

CREATE INDEX "assistance_request_tenant_id_user_id_status_idx"
  ON "assistance_request"("tenant_id", "user_id", "status");

-- One request still to be handled per person and organization: a second tap waits for the first.
CREATE UNIQUE INDEX "assistance_request_one_open_per_person"
  ON "assistance_request"("tenant_id", "user_id") WHERE "status" <> 'CLOSED';

ALTER TABLE "assistance_request" ADD CONSTRAINT "assistance_request_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "assistance_request" ADD CONSTRAINT "assistance_request_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
