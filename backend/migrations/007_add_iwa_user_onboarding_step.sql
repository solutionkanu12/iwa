-- Persists only the current Iwa onboarding stage.
--
-- This is progress metadata, not evidence that wallet credentials, recovery
-- material, or wallet authority exist. It must never hold any secret.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS onboarding_step TEXT;

UPDATE users
   SET onboarding_step = CASE
       WHEN onboarding_status = 'completed' THEN 'finish'
       ELSE 'profile'
   END
 WHERE onboarding_step IS NULL;

ALTER TABLE users
    ALTER COLUMN onboarding_step SET DEFAULT 'profile';

ALTER TABLE users
    ALTER COLUMN onboarding_step SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'users_onboarding_step_check'
           AND conrelid = 'users'::regclass
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT users_onboarding_step_check
            CHECK (onboarding_step IN ('profile', 'passwordPin', 'walletProvisioning', 'recovery', 'finish'));
    END IF;
END $$;
