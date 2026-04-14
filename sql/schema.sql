CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id VARCHAR(32) NOT NULL UNIQUE,
  persona_name TEXT NOT NULL,
  profile_url TEXT,
  avatar_url TEXT,
  avatar_medium_url TEXT,
  avatar_full_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS player_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  elo_2v2 INTEGER NOT NULL DEFAULT 100,
  wins_2v2 INTEGER NOT NULL DEFAULT 0,
  losses_2v2 INTEGER NOT NULL DEFAULT 0,
  matches_played_2v2 INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_match_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS launcher_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL UNIQUE,
  nickname TEXT,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS parties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  party_code TEXT NOT NULL UNIQUE,
  leader_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open',
  queue_mode TEXT NOT NULL DEFAULT '2x2',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT parties_status_check CHECK (status IN ('open','searching','in_match','closed'))
);

CREATE TABLE IF NOT EXISTS party_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id UUID NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (party_id, user_id),
  CONSTRAINT party_members_role_check CHECK (role IN ('leader','member'))
);

CREATE TABLE IF NOT EXISTS party_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id UUID NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes'),
  CONSTRAINT party_invites_status_check CHECK (status IN ('pending','accepted','declined','expired','cancelled'))
);

CREATE TABLE IF NOT EXISTS presence (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'offline',
  current_party_id UUID REFERENCES parties(id) ON DELETE SET NULL,
  current_match_id UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT presence_state_check CHECK (state IN ('online','in_party','searching','in_match','offline'))
);

CREATE TABLE IF NOT EXISTS queue_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id UUID NOT NULL UNIQUE REFERENCES parties(id) ON DELETE CASCADE,
  leader_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT '2x2',
  status TEXT NOT NULL DEFAULT 'queued',
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  matched_at TIMESTAMPTZ,
  CONSTRAINT queue_entries_status_check CHECK (status IN ('queued','matched','cancelled'))
);

CREATE TABLE IF NOT EXISTS matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_match_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL DEFAULT '2x2',
  status TEXT NOT NULL DEFAULT 'pending_acceptance',
  server_id TEXT,
  server_ip TEXT,
  server_port INTEGER,
  server_password TEXT,
  map_name TEXT,
  accepted_at TIMESTAMPTZ,
  accept_expires_at TIMESTAMPTZ,
  map_voting_started_at TIMESTAMPTZ,
  map_voting_finished_at TIMESTAMPTZ,
  selected_map_by TEXT,
  connect_expires_at TIMESTAMPTZ,
  team_a_score INTEGER NOT NULL DEFAULT 0,
  team_b_score INTEGER NOT NULL DEFAULT 0,
  winner_team TEXT,
  result_source TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT matches_status_check CHECK (status IN ('pending','pending_acceptance','map_voting','server_assigned','live','finished','cancelled')),
  CONSTRAINT matches_winner_team_check CHECK (winner_team IN ('A','B') OR winner_team IS NULL)
);

CREATE TABLE IF NOT EXISTS match_players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  party_id UUID REFERENCES parties(id) ON DELETE SET NULL,
  team TEXT NOT NULL,
  slot_index INTEGER NOT NULL,
  accepted_at TIMESTAMPTZ,
  map_vote TEXT,
  map_vote_at TIMESTAMPTZ,
  connection_state TEXT NOT NULL DEFAULT 'waiting_connect',
  reconnect_expires_at TIMESTAMPTZ,
  abandoned_at TIMESTAMPTZ,
  elo_before INTEGER,
  elo_after INTEGER,
  elo_delta INTEGER,
  result TEXT,
  connected_at TIMESTAMPTZ,
  UNIQUE (match_id, user_id),
  CONSTRAINT match_players_team_check CHECK (team IN ('A','B')),
  CONSTRAINT match_players_result_check CHECK (result IN ('win','loss') OR result IS NULL),
  CONSTRAINT match_players_connection_state_check CHECK (connection_state IN ('waiting_connect','connected','disconnected','abandoned'))
);

CREATE TABLE IF NOT EXISTS server_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  server_password TEXT,
  server_token TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  region TEXT NOT NULL DEFAULT 'EU',
  last_heartbeat_at TIMESTAMPTZ,
  UNIQUE (host, port),
  CONSTRAINT server_instances_status_check CHECK (status IN ('idle','reserved','live','offline'))
);

CREATE INDEX IF NOT EXISTS idx_users_steam_id ON users(steam_id);
CREATE INDEX IF NOT EXISTS idx_users_persona_lower ON users(LOWER(persona_name));
CREATE INDEX IF NOT EXISTS idx_party_invites_to_user ON party_invites(to_user_id, status);
CREATE INDEX IF NOT EXISTS idx_queue_entries_status ON queue_entries(status, queued_at);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_match_players_user ON match_players(user_id);

ALTER TABLE presence DROP CONSTRAINT IF EXISTS presence_current_match_fkey;
ALTER TABLE presence ADD CONSTRAINT presence_current_match_fkey FOREIGN KEY (current_match_id) REFERENCES matches(id) ON DELETE SET NULL;


ALTER TABLE matches ADD COLUMN IF NOT EXISTS result_ack_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE match_players ADD COLUMN IF NOT EXISTS result_seen_at TIMESTAMPTZ;
ALTER TABLE match_players ADD COLUMN IF NOT EXISTS joined_server_at TIMESTAMPTZ;
ALTER TABLE match_players ADD COLUMN IF NOT EXISTS disconnected_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS player_restriction_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  penalty_type TEXT NOT NULL,
  lock_category TEXT NOT NULL,
  reason_key TEXT NOT NULL,
  reason_title TEXT NOT NULL,
  reason_message TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'system',
  duration_seconds INTEGER NOT NULL,
  locked_until TIMESTAMPTZ NOT NULL,
  match_id UUID REFERENCES matches(id) ON DELETE SET NULL,
  match_player_id UUID REFERENCES match_players(id) ON DELETE SET NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS player_restrictions (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  penalty_type TEXT NOT NULL,
  lock_category TEXT NOT NULL,
  reason_key TEXT NOT NULL,
  reason_title TEXT NOT NULL,
  reason_message TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'system',
  locked_until TIMESTAMPTZ NOT NULL,
  active_match_id UUID REFERENCES matches(id) ON DELETE SET NULL,
  active_match_player_id UUID REFERENCES match_players(id) ON DELETE SET NULL,
  metadata JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_player_restrictions_active ON player_restrictions(user_id, locked_until DESC);
CREATE INDEX IF NOT EXISTS idx_player_restriction_events_user ON player_restriction_events(user_id, created_at DESC);
