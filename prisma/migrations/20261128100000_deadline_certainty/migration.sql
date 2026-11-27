-- How sure a deadline is (Fase 1B): confirmed, to be checked, or for information only.
-- Only additions: every existing deadline is confirmed.
-- Rollback: prisma/rollback/20261128100000_deadline_certainty.down.sql

-- CreateEnum
CREATE TYPE "DeadlineCertainty" AS ENUM ('CONFIRMED', 'TO_VERIFY', 'INFORMATIONAL');

-- AlterTable
ALTER TABLE "compliance_deadline" ADD COLUMN     "certainty" "DeadlineCertainty" NOT NULL DEFAULT 'CONFIRMED',
ADD COLUMN     "verified_at" TIMESTAMP(3),
ADD COLUMN     "verified_by" UUID;
