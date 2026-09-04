-- Phone becomes a real login identifier (POST /login/phone), so it can no
-- longer be optional. The only rows with a null phone today are disposable
-- internal-test self-registrations created before this feature existed
-- (name-only, no password) - they can't log in under the new flow either
-- way, so they're removed rather than backfilled.
DELETE FROM "distributors" WHERE "phone" IS NULL;

ALTER TABLE "distributors" ALTER COLUMN "phone" SET NOT NULL;
ALTER TABLE "distributors" ADD CONSTRAINT "distributors_phone_key" UNIQUE ("phone");

-- Nullable: only ever set for self-registered distributors (POST /register).
-- Seeded accounts and future invite-token distributors authenticate a
-- different way and never get a value here.
ALTER TABLE "distributors" ADD COLUMN "password_hash" TEXT;
