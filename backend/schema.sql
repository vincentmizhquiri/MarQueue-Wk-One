-- =====================================================================
-- MarQueue-wk-one  ·  PostgreSQL schema (the "backend" data layer)
-- =====================================================================
-- This file is the real backend blueprint. The browser demo (js/data.js)
-- imitates these exact tables/columns in memory so the front end is built
-- against the SAME shape you will deploy to Postgres / Supabase later.
--
-- Run order matters: enums -> tables -> indexes -> Row Level Security.
-- Maps 1:1 to PRD Section 4 "Recording Session Data Model".
-- =====================================================================

-- ---------- 0. Extensions ----------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid(), crypt()

-- ---------- 1. Enum for the recording state machine (PRD Sec 4) ----------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'recording_status') THEN
    CREATE TYPE recording_status AS ENUM (
      'idle', 'recording', 'processing', 'uploading', 'complete', 'failed'
    );
  END IF;
END$$;

-- ---------- 2. Users ----------
-- In production this is Supabase's built-in auth.users table.
-- It is shown here so the demo's data model is self-contained and clear.
CREATE TABLE IF NOT EXISTS app_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  -- NEVER store a plaintext password. Postgres example uses bcrypt via crypt().
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 3. Recordings (PRD Section 4) ----------
CREATE TABLE IF NOT EXISTS recordings (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  title                TEXT NOT NULL DEFAULT 'Untitled recording',
  script_text          TEXT,                                  -- optional notes/script
  status               recording_status NOT NULL DEFAULT 'idle',
  duration_seconds     INTEGER NOT NULL DEFAULT 0
                         CHECK (duration_seconds >= 0 AND duration_seconds <= 900), -- 15 min cap
  resolution           TEXT,                                  -- e.g. '1920x1080'
  codec                TEXT,                                  -- 'video/webm;codecs=vp9'
  share_token          TEXT UNIQUE,                           -- unguessable share id
  storage_path         TEXT,                                  -- private bucket object path
  local_blob_available BOOLEAN NOT NULL DEFAULT false,        -- in-session retry possible
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 4. Indexes ----------
CREATE INDEX IF NOT EXISTS idx_recordings_user_id     ON recordings(user_id);
CREATE INDEX IF NOT EXISTS idx_recordings_share_token ON recordings(share_token);

-- ---------- 5. Row Level Security (PRD: "users read/write only their own rows") ----------
ALTER TABLE recordings ENABLE ROW LEVEL SECURITY;

-- Owners can do anything with their own rows.
DROP POLICY IF EXISTS recordings_owner_all ON recordings;
CREATE POLICY recordings_owner_all
  ON recordings
  FOR ALL
  USING (auth.uid() = user_id)         -- Supabase exposes auth.uid()
  WITH CHECK (auth.uid() = user_id);

-- Public share playback is handled WITHOUT exposing the table: a server
-- endpoint looks up the row by share_token and returns a short-lived signed
-- URL. The bucket itself stays private. (PRD: Share-Link Security Model.)

-- ---------- 6. Telemetry (PRD Section 7 - minimal, internal) ----------
CREATE TABLE IF NOT EXISTS telemetry_events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES app_users(id) ON DELETE SET NULL,
  event_name  TEXT NOT NULL,        -- recording_started, upload_failed, ...
  attempt     INTEGER,              -- upload attempt count where relevant
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- End of schema. The demo never connects to this file directly; it is the
-- contract that js/data.js imitates so you can graduate to a real backend
-- without rewriting the front end.
-- =====================================================================
