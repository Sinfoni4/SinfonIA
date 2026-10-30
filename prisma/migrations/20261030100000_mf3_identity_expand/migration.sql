-- MF3 (expand step, M1): organizations, global identities, memberships, channel identities,
-- sessions, one-time challenges, invitations, delegations.
-- docs/PROGETTO_FASE1_IDENTITA_SICUREZZA.md §1-§5 and §9.
--
-- Additive only: no existing column, table or constraint is changed or removed. The legacy
-- columns (user.tenant_id, user.role, user.telegram_id, whatsapp_identity) stay the source the
-- current code writes; triggers below keep the new tables in step until the code switches (MF4).
-- Rollback: prisma/rollback/20261030100000_mf3_identity_expand.down.sql

-- Enums ----------------------------------------------------------------------------------------
CREATE TYPE "OrganizationType" AS ENUM ('COMPANY', 'NETWORK', 'CONSORTIUM', 'TRADE_ASSOCIATION', 'ASSOCIATION', 'PROFESSIONAL_FIRM', 'OTHER');
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'PENDING_DELETION');
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DISABLED');
CREATE TYPE "PlatformRole" AS ENUM ('NONE', 'PLATFORM_ADMIN');
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');
CREATE TYPE "ChannelType" AS ENUM ('TELEGRAM', 'WHATSAPP');
CREATE TYPE "RelationType" AS ENUM ('MEMBER_OF');
CREATE TYPE "RelationStatus" AS ENUM ('PENDING', 'ACTIVE', 'ENDED');
CREATE TYPE "AuthChallengePurpose" AS ENUM ('LOGIN', 'INVITATION', 'TELEGRAM_LINK', 'EMAIL_ADD');
CREATE TYPE "GranteeType" AS ENUM ('USER', 'ORGANIZATION');
CREATE TYPE "GrantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');
CREATE TYPE "GrantOperation" AS ENUM ('READ', 'CREATE', 'UPDATE', 'APPROVE', 'DELETE', 'EXPORT');
CREATE TYPE "BeneficiaryStatus" AS ENUM ('PROPOSED', 'ACTIVE', 'REVOKED');

-- New columns on existing tables (defaults only, nothing rewritten) ----------------------------
ALTER TABLE "tenant"
  ADD COLUMN "type" "OrganizationType" NOT NULL DEFAULT 'COMPANY',
  ADD COLUMN "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "deactivated_at" timestamptz,
  ADD COLUMN "deletion_scheduled_at" timestamptz;

ALTER TABLE "user"
  ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "email_verified_at" timestamptz,
  ADD COLUMN "auth_version" integer NOT NULL DEFAULT 0,
  ADD COLUMN "platform_role" "PlatformRole" NOT NULL DEFAULT 'NONE';

-- Memberships ------------------------------------------------------------------------------------
CREATE TABLE "membership" (
  "id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "role" "UserRole" NOT NULL,
  "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
  "extra_permissions" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "invited_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz,
  "revoked_by" uuid,
  "revocation_reason" text,
  CONSTRAINT "membership_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "membership_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "membership_user_id_org_id_key" ON "membership"("user_id", "org_id");
CREATE INDEX "membership_org_id_status_idx" ON "membership"("org_id", "status");

-- Channel identities: at most one ACTIVE link per chat account -----------------------------------
CREATE TABLE "channel_identity" (
  "id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "channel" "ChannelType" NOT NULL,
  "external_id" text NOT NULL,
  -- Set when linked through the verified procedure (MF7); NULL for links made with the legacy
  -- invite codes, which did not verify the application account.
  "verified_at" timestamptz,
  "last_used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz,
  "revoked_by" uuid,
  CONSTRAINT "channel_identity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "channel_identity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "channel_identity_user_id_idx" ON "channel_identity"("user_id");
CREATE INDEX "channel_identity_channel_external_id_idx" ON "channel_identity"("channel", "external_id");
CREATE UNIQUE INDEX "channel_identity_active_key" ON "channel_identity"("channel", "external_id") WHERE "revoked_at" IS NULL;

-- Relations between organizations (grant no permission on data by themselves) -----------------
CREATE TABLE "organization_relation" (
  "id" uuid NOT NULL,
  "parent_org_id" uuid NOT NULL,
  "child_org_id" uuid NOT NULL,
  "relation_type" "RelationType" NOT NULL DEFAULT 'MEMBER_OF',
  "status" "RelationStatus" NOT NULL DEFAULT 'PENDING',
  "requested_by" uuid,
  "confirmed_by" uuid,
  "started_at" timestamptz,
  "ended_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_relation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "organization_relation_parent_org_id_fkey" FOREIGN KEY ("parent_org_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "organization_relation_child_org_id_fkey" FOREIGN KEY ("child_org_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "organization_relation_not_self" CHECK ("parent_org_id" <> "child_org_id")
);
CREATE UNIQUE INDEX "organization_relation_parent_org_id_child_org_id_relation_type_key" ON "organization_relation"("parent_org_id", "child_org_id", "relation_type");
CREATE INDEX "organization_relation_child_org_id_idx" ON "organization_relation"("child_org_id");

-- Sessions, one-time challenges, invitations ---------------------------------------------------
CREATE TABLE "session" (
  "id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "auth_version" integer NOT NULL,
  "refresh_token_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "revocation_reason" text,
  CONSTRAINT "session_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "session_refresh_token_hash_key" ON "session"("refresh_token_hash");
CREATE INDEX "session_user_id_idx" ON "session"("user_id");

CREATE TABLE "auth_challenge" (
  "id" uuid NOT NULL,
  "purpose" "AuthChallengePurpose" NOT NULL,
  "email" text,
  "user_id" uuid,
  "channel_external_id" text,
  "code_hash" text NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "auth_challenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "auth_challenge_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "auth_challenge_attempts_range" CHECK ("attempts" >= 0)
);
CREATE INDEX "auth_challenge_purpose_email_idx" ON "auth_challenge"("purpose", "email");
CREATE INDEX "auth_challenge_expires_at_idx" ON "auth_challenge"("expires_at");

CREATE TABLE "invitation" (
  "id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "email" text NOT NULL,
  "role" "UserRole" NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "accepted_at" timestamptz,
  "accepted_by" uuid,
  "revoked_at" timestamptz,
  "created_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "invitation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "invitation_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "invitation_token_hash_key" ON "invitation"("token_hash");
CREATE INDEX "invitation_org_id_idx" ON "invitation"("org_id");

-- Delegations ------------------------------------------------------------------------------------
CREATE TABLE "access_grant" (
  "id" uuid NOT NULL,
  "grantor_org_id" uuid NOT NULL,
  "grantee_type" "GranteeType" NOT NULL,
  "grantee_user_id" uuid,
  "grantee_org_id" uuid,
  "scope" jsonb NOT NULL,
  "operations" "GrantOperation"[] NOT NULL,
  "valid_from" timestamptz NOT NULL DEFAULT now(),
  "valid_until" timestamptz NOT NULL,
  "status" "GrantStatus" NOT NULL DEFAULT 'ACTIVE',
  "created_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz,
  "revoked_by" uuid,
  "revocation_reason" text,
  CONSTRAINT "access_grant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "access_grant_grantor_org_id_fkey" FOREIGN KEY ("grantor_org_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "access_grant_grantee_user_id_fkey" FOREIGN KEY ("grantee_user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "access_grant_grantee_org_id_fkey" FOREIGN KEY ("grantee_org_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- Exactly one grantee, matching its type; never the grantor itself; an end date after the start.
  CONSTRAINT "access_grant_grantee_matches_type" CHECK (
    ("grantee_type" = 'USER' AND "grantee_user_id" IS NOT NULL AND "grantee_org_id" IS NULL)
    OR ("grantee_type" = 'ORGANIZATION' AND "grantee_org_id" IS NOT NULL AND "grantee_user_id" IS NULL)
  ),
  CONSTRAINT "access_grant_not_self" CHECK ("grantee_org_id" IS NULL OR "grantee_org_id" <> "grantor_org_id"),
  CONSTRAINT "access_grant_valid_period" CHECK ("valid_until" > "valid_from"),
  CONSTRAINT "access_grant_has_operations" CHECK (cardinality("operations") > 0)
);
CREATE INDEX "access_grant_grantor_org_id_status_idx" ON "access_grant"("grantor_org_id", "status");
CREATE INDEX "access_grant_grantee_user_id_idx" ON "access_grant"("grantee_user_id");
CREATE INDEX "access_grant_grantee_org_id_idx" ON "access_grant"("grantee_org_id");

CREATE TABLE "access_grant_beneficiary" (
  "id" uuid NOT NULL,
  "grant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "status" "BeneficiaryStatus" NOT NULL DEFAULT 'PROPOSED',
  "proposed_by" uuid,
  "approved_by" uuid,
  "approved_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz,
  CONSTRAINT "access_grant_beneficiary_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "access_grant_beneficiary_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "access_grant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "access_grant_beneficiary_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "access_grant_beneficiary_grant_id_user_id_key" ON "access_grant_beneficiary"("grant_id", "user_id");

-- Backfill from the current data -----------------------------------------------------------------
-- One membership per user, in the user's tenant, with the user's role.
INSERT INTO "membership" ("id", "user_id", "org_id", "role", "status", "created_at", "updated_at")
SELECT gen_random_uuid(), u."id", u."tenant_id", u."role", 'ACTIVE', u."created_at", now()
FROM "user" u
ON CONFLICT ("user_id", "org_id") DO NOTHING;

-- One active link per Telegram account. When several users share a Telegram id (same person
-- linked to two tenants), the most recent one holds it, as the current resolver already does.
INSERT INTO "channel_identity" ("id", "user_id", "channel", "external_id", "created_at")
SELECT DISTINCT ON (u."telegram_id") gen_random_uuid(), u."id", 'TELEGRAM', u."telegram_id", u."created_at"
FROM "user" u
WHERE u."telegram_id" IS NOT NULL
ORDER BY u."telegram_id", u."created_at" DESC;

INSERT INTO "channel_identity" ("id", "user_id", "channel", "external_id", "created_at")
SELECT DISTINCT ON (w."phone_number") gen_random_uuid(), w."user_id", 'WHATSAPP', w."phone_number", w."created_at"
FROM "whatsapp_identity" w
ORDER BY w."phone_number", w."created_at" DESC;

-- Transition triggers: the current code writes only the legacy columns ---------------------------
CREATE OR REPLACE FUNCTION mf3_link_channel(p_user uuid, p_channel "ChannelType", p_external text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- Most recent link wins (same rule as the legacy resolver): older active links of this account,
  -- and other active links of this user on the same channel, are revoked.
  UPDATE "channel_identity"
     SET "revoked_at" = now()
   WHERE "revoked_at" IS NULL
     AND "channel" = p_channel
     AND (("external_id" = p_external AND "user_id" <> p_user)
          OR ("user_id" = p_user AND "external_id" <> p_external));
  IF NOT EXISTS (SELECT 1 FROM "channel_identity"
                  WHERE "revoked_at" IS NULL AND "channel" = p_channel
                    AND "external_id" = p_external AND "user_id" = p_user) THEN
    INSERT INTO "channel_identity" ("id", "user_id", "channel", "external_id")
    VALUES (gen_random_uuid(), p_user, p_channel, p_external);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION mf3_sync_user()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "membership" ("id", "user_id", "org_id", "role", "status")
  VALUES (gen_random_uuid(), NEW."id", NEW."tenant_id", NEW."role", 'ACTIVE')
  ON CONFLICT ("user_id", "org_id")
  DO UPDATE SET "role" = EXCLUDED."role", "updated_at" = now();

  IF TG_OP = 'UPDATE' AND OLD."tenant_id" <> NEW."tenant_id" THEN
    UPDATE "membership"
       SET "status" = 'REVOKED', "revoked_at" = now(), "updated_at" = now(),
           "revocation_reason" = 'legacy tenant change'
     WHERE "user_id" = NEW."id" AND "org_id" = OLD."tenant_id" AND "status" <> 'REVOKED';
  END IF;

  IF NEW."telegram_id" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."telegram_id" IS DISTINCT FROM OLD."telegram_id") THEN
    PERFORM mf3_link_channel(NEW."id", 'TELEGRAM', NEW."telegram_id");
  ELSIF NEW."telegram_id" IS NULL AND TG_OP = 'UPDATE' AND OLD."telegram_id" IS NOT NULL THEN
    UPDATE "channel_identity" SET "revoked_at" = now()
     WHERE "revoked_at" IS NULL AND "channel" = 'TELEGRAM' AND "user_id" = NEW."id";
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER mf3_sync_user
  AFTER INSERT OR UPDATE OF "tenant_id", "role", "telegram_id" ON "user"
  FOR EACH ROW EXECUTE FUNCTION mf3_sync_user();

CREATE OR REPLACE FUNCTION mf3_sync_whatsapp()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE "channel_identity" SET "revoked_at" = now()
     WHERE "revoked_at" IS NULL AND "channel" = 'WHATSAPP'
       AND "user_id" = OLD."user_id" AND "external_id" = OLD."phone_number";
    RETURN NULL;
  END IF;
  PERFORM mf3_link_channel(NEW."user_id", 'WHATSAPP', NEW."phone_number");
  RETURN NULL;
END;
$$;

CREATE TRIGGER mf3_sync_whatsapp
  AFTER INSERT OR UPDATE OF "phone_number", "user_id" OR DELETE ON "whatsapp_identity"
  FOR EACH ROW EXECUTE FUNCTION mf3_sync_whatsapp();
