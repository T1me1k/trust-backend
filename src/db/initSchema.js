const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

async function tableExists(client, tableName) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return !!result.rows[0]?.exists;
}

async function columnExists(client, tableName, columnName) {
  const result = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );
  return !!result.rows[0];
}

async function applyBaseSchema(client) {
  const schemaPath = path.join(__dirname, '../../sql/schema.sql');
  await client.query(fs.readFileSync(schemaPath, 'utf8'));
}

async function repairUsersAndProfiles(client) {
  await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS profile_url TEXT,
      ADD COLUMN IF NOT EXISTS avatar_url TEXT,
      ADD COLUMN IF NOT EXISTS avatar_medium_url TEXT,
      ADD COLUMN IF NOT EXISTS avatar_full_url TEXT,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
  `);

  await client.query(`
    ALTER TABLE player_profiles
      ADD COLUMN IF NOT EXISTS elo_2v2 INTEGER NOT NULL DEFAULT 100,
      ADD COLUMN IF NOT EXISTS wins_2v2 INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS losses_2v2 INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS matches_played_2v2 INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS last_match_at TIMESTAMPTZ;
  `);
}

async function repairLegacyPartyTables(client) {
  const partyTableExists = await tableExists(client, 'parties');
  if (!partyTableExists) return;

  const hasLeaderClientId = await columnExists(client, 'parties', 'leader_client_id');
  const hasPartyCode = await columnExists(client, 'parties', 'party_code');
  const hasLeaderUserId = await columnExists(client, 'parties', 'leader_user_id');

  if (hasLeaderClientId || !hasPartyCode || !hasLeaderUserId) {
    console.log('[db] legacy parties detected; recreating parties, party_members and party_invites');
    await client.query(`
      DROP TABLE IF EXISTS party_invites CASCADE;
      DROP TABLE IF EXISTS party_members CASCADE;
      DROP TABLE IF EXISTS parties CASCADE;
    `);

    await client.query(`
      CREATE TABLE parties (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        party_code TEXT NOT NULL UNIQUE,
        leader_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'open',
        queue_mode TEXT NOT NULL DEFAULT '2x2',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT parties_status_check CHECK (status IN ('open','searching','in_match','closed'))
      );

      CREATE TABLE party_members (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        party_id UUID NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member',
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (party_id, user_id),
        CONSTRAINT party_members_role_check CHECK (role IN ('leader','member'))
      );

      CREATE TABLE party_invites (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        party_id UUID NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
        from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        to_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes'),
        CONSTRAINT party_invites_status_check CHECK (status IN ('pending','accepted','declined','expired','cancelled'))
      );

      CREATE INDEX idx_party_invites_to_user ON party_invites(to_user_id, status);
      CREATE INDEX idx_party_members_user ON party_members(user_id);
    `);
    return;
  }

  await client.query(`
    ALTER TABLE parties
      ADD COLUMN IF NOT EXISTS party_code TEXT,
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open',
      ADD COLUMN IF NOT EXISTS queue_mode TEXT NOT NULL DEFAULT '2x2',
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  await client.query(`
    UPDATE parties
    SET party_code = UPPER(SUBSTRING(REPLACE(gen_random_uuid()::text, '-', '') FROM 1 FOR 6))
    WHERE party_code IS NULL OR TRIM(party_code) = '';
  `);

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_parties_party_code_unique ON parties(party_code);
    CREATE INDEX IF NOT EXISTS idx_party_members_user ON party_members(user_id);
  `);
}

async function repairMatchmakingTables(client) {
  await client.query(`
    ALTER TABLE queue_entries
      ADD COLUMN IF NOT EXISTS party_id UUID,
      ADD COLUMN IF NOT EXISTS leader_user_id UUID,
      ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT '2x2',
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'queued',
      ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS matched_at TIMESTAMPTZ;
  `);

  await client.query(`
    ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS accept_expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS map_voting_started_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS map_voting_finished_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS selected_map_by TEXT,
      ADD COLUMN IF NOT EXISTS connect_expires_at TIMESTAMPTZ;
  `);

  await client.query(`
    ALTER TABLE match_players
      ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS map_vote TEXT,
      ADD COLUMN IF NOT EXISTS map_vote_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS connection_state TEXT NOT NULL DEFAULT 'waiting_connect',
      ADD COLUMN IF NOT EXISTS reconnect_expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS abandoned_at TIMESTAMPTZ;
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_match_players_match_id ON match_players(match_id);
    CREATE INDEX IF NOT EXISTS idx_queue_entries_status ON queue_entries(status, queued_at);
  `);

  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='matches' AND column_name='status'
      ) THEN
        ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_status_check;
        ALTER TABLE matches ADD CONSTRAINT matches_status_check
          CHECK (status IN ('pending','pending_acceptance','map_voting','server_assigned','live','finished','cancelled'));
      END IF;
    END $$;
  `);
}

async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await applyBaseSchema(client);
    await repairUsersAndProfiles(client);
    await repairLegacyPartyTables(client);
    await applyBaseSchema(client);
    await repairMatchmakingTables(client);
    await client.query('COMMIT');
    console.log('[db] schema initialized');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[db] schema initialization failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { initSchema };
