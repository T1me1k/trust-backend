CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    steam_id VARCHAR(32) NOT NULL UNIQUE,
    persona_name TEXT,
    profile_url TEXT,
    avatar_url TEXT,
    avatar_medium_url TEXT,
    avatar_full_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS launcher_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL UNIQUE,
    nickname TEXT,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_launcher_links_user_id
ON launcher_links(user_id);

CREATE TABLE IF NOT EXISTS launcher_link_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(16) NOT NULL UNIQUE,
    client_id TEXT NOT NULL,
    nickname TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    consumed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_launcher_link_codes_code
ON launcher_link_codes(code);

CREATE INDEX IF NOT EXISTS idx_launcher_link_codes_client_id
ON launcher_link_codes(client_id);

CREATE INDEX IF NOT EXISTS idx_launcher_link_codes_expires_at
ON launcher_link_codes(expires_at);