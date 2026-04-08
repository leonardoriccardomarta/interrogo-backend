ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT,
  ADD COLUMN IF NOT EXISTS "stripeSubscriptionId" TEXT,
  ADD COLUMN IF NOT EXISTS "billingPlan" TEXT NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS "billingStatus" TEXT NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS "billingCurrentPeriodEnd" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "billingUpdatedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "users_stripeCustomerId_key" ON "users"("stripeCustomerId");
CREATE UNIQUE INDEX IF NOT EXISTS "users_stripeSubscriptionId_key" ON "users"("stripeSubscriptionId");