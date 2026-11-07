CREATE TABLE IF NOT EXISTS ss_admins (
 id uuid PRIMARY KEY,
 email text NOT NULL UNIQUE,
 password_hash text NOT NULL,
 disabled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ss_admin_sessions (
 token_hash text PRIMARY KEY,
 admin_id uuid NOT NULL REFERENCES ss_admins(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ss_whatsapp_auth (
 key_type text NOT NULL,
 key_id text NOT NULL,
 ciphertext text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (key_type,key_id)
);
CREATE TABLE IF NOT EXISTS ss_whatsapp_leases (
 id text PRIMARY KEY,
 owner text NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS ss_sticker_requests (
 id uuid PRIMARY KEY,
 token_hash text NOT NULL UNIQUE,
 sticker_ciphertext text,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','delivered','failed','expired')),
 recipient_hash text,
 message_id text,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 claimed_at timestamptz,
 completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS ss_sticker_requests_status_created ON ss_sticker_requests(status,created_at DESC);
CREATE INDEX IF NOT EXISTS ss_sticker_requests_recipient_claimed ON ss_sticker_requests(recipient_hash,claimed_at DESC);
CREATE TABLE IF NOT EXISTS ss_admin_events (
 id uuid PRIMARY KEY,
 type text NOT NULL,
 message text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ss_rate_limits (
 key text PRIMARY KEY,
 count integer NOT NULL,
 expires_at timestamptz NOT NULL
);
