CREATE TABLE ss_whatsapp_batches (
 id uuid PRIMARY KEY,
 token_hash text NOT NULL UNIQUE,
 request_hash text NOT NULL,
 recipient_hash text NOT NULL,
 cancelled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes'
);
CREATE TABLE ss_whatsapp_batch_items (
 id uuid PRIMARY KEY,
 batch_id uuid NOT NULL REFERENCES ss_whatsapp_batches(id) ON DELETE CASCADE,
 position integer NOT NULL CHECK(position BETWEEN 1 AND 10),
 source_ciphertext text,
 delivery_token_hash text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','preparing','sending','sent','failed','stopped')),
 error_code text,
 error_message text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(batch_id,position)
);
CREATE INDEX ss_whatsapp_batch_items_pending ON ss_whatsapp_batch_items(batch_id,position) WHERE status IN ('queued','preparing','sending');
CREATE TABLE ss_whatsapp_batch_lock (
 id text PRIMARY KEY,
 owner text NOT NULL,
 expires_at timestamptz NOT NULL
);
