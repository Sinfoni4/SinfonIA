-- AGX-07: usage events. One row for each unit of work done for an organization (a document
-- received, OCR pages, an AI call, a practice opened or completed, a document request, an
-- assistance request closed). Written in the same transaction as the work, with a unique key, so
-- a retry never counts twice. Append-only: a wrong event is reversed by a new one that points to
-- it (`correction_of`), never changed. The cost is computed when reading, never stored.
-- Additive only.

CREATE TYPE "UsageKind" AS ENUM (
    'DOCUMENT_RECEIVED',
    'OCR_PAGES',
    'AI_CALL',
    'AI_TOKENS',
    'PRACTICE_OPENED',
    'PRACTICE_COMPLETED',
    'DOCUMENT_REQUESTED',
    'ASSISTANCE_CLOSED'
);

CREATE TABLE "usage_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "idempotency_key" TEXT NOT NULL,
    -- The organization the work was done for (whose data it is).
    "tenant_id" UUID NOT NULL,
    -- The organization that did the work when not the same one (a network through a delegation).
    "actor_org_id" UUID,
    "user_id" UUID,
    "kind" "UsageKind" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit" TEXT NOT NULL,
    -- The practice the work belongs to, when there is one (no foreign key: the event outlives it).
    "practice_id" UUID,
    -- A reversal: the event it cancels, with the opposite quantity.
    "correction_of" UUID,
    "reason" TEXT,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "usage_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "usage_event_idempotency_key_key" ON "usage_event"("idempotency_key");

-- An event is reversed at most once.
CREATE UNIQUE INDEX "usage_event_correction_of_key" ON "usage_event"("correction_of");

CREATE INDEX "usage_event_tenant_id_occurred_at_idx" ON "usage_event"("tenant_id", "occurred_at");

CREATE INDEX "usage_event_actor_org_id_occurred_at_idx"
  ON "usage_event"("actor_org_id", "occurred_at");

CREATE INDEX "usage_event_occurred_at_idx" ON "usage_event"("occurred_at");

ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_correction_of_fkey"
  FOREIGN KEY ("correction_of") REFERENCES "usage_event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Append-only: rows are never changed. Deleting stays possible, only for the erasure of a whole
-- organization (cascade from tenant).
CREATE FUNCTION "usage_event_no_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'usage_event is append-only';
END;
$$;

CREATE TRIGGER "usage_event_append_only"
  BEFORE UPDATE ON "usage_event"
  FOR EACH ROW EXECUTE FUNCTION "usage_event_no_update"();
