-- Staging database schema: link admin users to Supabase Auth identities
-- 0003_admin_auth_identity.sql (Idempotent)

-- 1. Add nullable UUID column if it does not exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'admin_users' AND column_name = 'auth_user_id'
    ) THEN
        ALTER TABLE admin_users ADD COLUMN auth_user_id UUID;
    END IF;
END $$;

-- 2. Add foreign key referencing auth.users(id) with ON DELETE CASCADE
-- In Supabase, the 'auth' schema and 'users' table exist globally.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.table_constraints 
        WHERE constraint_name = 'fk_admin_users_auth_users'
    ) THEN
        ALTER TABLE admin_users 
        ADD CONSTRAINT fk_admin_users_auth_users 
        FOREIGN KEY (auth_user_id) 
        REFERENCES auth.users(id) 
        ON DELETE CASCADE;
    END IF;
END $$;

-- 3. Add a unique index for non-null auth_user_id
CREATE UNIQUE INDEX IF NOT EXISTS admin_users_auth_user_id_uidx ON admin_users (auth_user_id) WHERE auth_user_id IS NOT NULL;

-- 4. Add a lookup index for query performance
CREATE INDEX IF NOT EXISTS admin_users_auth_user_id_idx ON admin_users (auth_user_id);
