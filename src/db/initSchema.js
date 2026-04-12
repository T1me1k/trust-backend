const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

async function columnExists(client, tableName, columnName) {
  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
      LIMIT 1
    `,
    [tableName, columnName]
  );

  return !!result.rows[0];
}

async function repairLegacyPartyTables(client) {
  await client.query(`
    ALTER TABLE parties
      ADD COLUMN IF NOT EXISTS leader_user_id UUID,
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open',
      ADD COLUMN IF NOT EXISTS queue_mode TEXT NOT NULL DEFAULT '2x2',
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  await client.query(`
    ALTER TABLE party_members
      ADD COLUMN IF NOT EXISTS party_id UUID,
      ADD COLUMN IF NOT EXISTS user_id UUID,
      ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member',
      ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_name = 'party_members'
          AND constraint_name = 'party_members_party_id_fkey'
      ) THEN
        ALTER TABLE party_members
          ADD CONSTRAINT party_members_party_id_fkey
          FOREIGN KEY (party_id) REFERENCES parties(id) ON DELETE CASCADE;
      END IF;
    END $$;
  `);

  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_name = 'party_members'
          AND constraint_name = 'party_members_user_id_fkey'
      ) THEN
        ALTER TABLE party_members
          ADD CONSTRAINT party_members_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
      END IF;
    END $$;
  `);

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_party_members_party_user_unique
      ON party_members(party_id, user_id);
  `);
}

async function repairLegacyUsers(client) {
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

async function recreateManagedTables(client) {
  console.log('[db] legacy managed tables detected; recreating matchmaking tables');

  await client.query(`
    DROP TABLE IF EXISTS match_players CASCADE;
    DROP TABLE IF EXISTS presence CASCADE;
    DROP TABLE IF EXISTS matches CASCADE;
    DROP TABLE IF EXISTS queue_entries CASCADE;
    DROP TABLE IF EXISTS party_invites CASCADE;
    DROP TABLE IF EXISTS server_instances CASCADE;
  `);

  await client.query(`
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
      status TEXT NOT NULL DEFAULT 'pending',
      server_id TEXT,
      server_ip TEXT,
      server_port INTEGER,
      server_password TEXT,
      map_name TEXT DEFAULT 'de_dust2',
      team_a_score INTEGER NOT NULL DEFAULT 0,
      team_b_score INTEGER NOT NULL DEFAULT 0,
      winner_team TEXT,
      result_source TEXT,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT matches_status_check CHECK (status IN ('pending','server_assigned','live','finished','cancelled')),
      CONSTRAINT matches_winner_team_check CHECK (winner_team IN ('A','B') OR winner_team IS NULL)
    );

    CREATE TABLE IF NOT EXISTS match_players (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      party_id UUID REFERENCES parties(id) ON DELETE SET NULL,
      team TEXT NOT NULL,
      slot_index INTEGER NOT NULL,
      elo_before INTEGER,
      elo_after INTEGER,
      elo_delta INTEGER,
      result TEXT,
      connected_at TIMESTAMPTZ,
      UNIQUE (match_id, user_id),
      CONSTRAINT match_players_team_check CHECK (team IN ('A','B')),
      CONSTRAINT match_players_result_check CHECK (result IN ('win','loss') OR result IS NULL)
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

    ALTER TABLE presence
      DROP CONSTRAINT IF EXISTS presence_current_match_fkey;

    ALTER TABLE presence
      ADD CONSTRAINT presence_current_match_fkey
      FOREIGN KEY (current_match_id) REFERENCES matches(id) ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS idx_party_invites_to_user
      ON party_invites(to_user_id, status);

    CREATE INDEX IF NOT EXISTS idx_queue_entries_status
      ON queue_entries(status, queued_at);

    CREATE INDEX IF NOT EXISTS idx_matches_status
      ON matches(status, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_match_players_user
      ON match_players(user_id);
  `);
}

async function initSchema() {
  const schemaPath = path.join(__dirname, '../../sql/schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(sql);

    await repairLegacyUsers(client);
    
await repairLegacyPartyTables(client);
    
    const presenceHasUserId = await columnExists(client, 'presence', 'user_id');
    const presenceHasState = await columnExists(client, 'presence', 'state');
    const presenceHasCurrentPartyId = await columnExists(client, 'presence', 'current_party_id');
    const presenceHasUpdatedAt = await columnExists(client, 'presence', 'updated_at');

    if (!presenceHasUserId || !presenceHasState || !presenceHasCurrentPartyId || !presenceHasUpdatedAt) {
      console.log(
        `[db] presence is missing columns: ${[
          !presenceHasUserId ? 'user_id' : null,
          !presenceHasState ? 'state' : null,
          !presenceHasCurrentPartyId ? 'current_party_id' : null,
          !presenceHasUpdatedAt ? 'updated_at' : null
        ]
          .filter(Boolean)
          .join(', ')}`
      );

      await recreateManagedTables(client);
    }

    await client.query('COMMIT');
    console.log('[db] schema initialized');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[db] schema init failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { initSchema };
