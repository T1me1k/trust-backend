const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

const MANAGED_TABLES = {
  party_invites: ['id', 'party_id', 'from_user_id', 'to_user_id', 'status', 'created_at', 'expires_at'],
  presence: ['user_id', 'state', 'current_party_id', 'current_match_id', 'updated_at'],
  queue_entries: ['id', 'party_id', 'leader_user_id', 'mode', 'status', 'queued_at', 'matched_at'],
  matches: ['id', 'public_match_id', 'mode', 'status', 'server_id', 'server_ip', 'server_port', 'server_password', 'map_name', 'team_a_score', 'team_b_score', 'winner_team', 'result_source', 'started_at', 'finished_at', 'created_at'],
  match_players: ['id', 'match_id', 'user_id', 'party_id', 'team', 'slot_index', 'elo_before', 'elo_after', 'elo_delta', 'result', 'connected_at'],
  server_instances: ['id', 'name', 'host', 'port', 'server_password', 'server_token', 'status', 'region', 'last_heartbeat_at']
};

const RESET_ORDER = [
  'match_players',
  'presence',
  'matches',
  'queue_entries',
  'party_invites',
  'server_instances'
];

async function getPublicColumns(client, tableName) {
  const result = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1`,
    [tableName]
  );
  return result.rows.map((row) => row.column_name);
}

async function tableExists(client, tableName) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return !!result.rows[0]?.exists;
}

async function hasPrimaryKeyOnId(client, tableName) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS c
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.table_name = $1
        AND tc.constraint_type = 'PRIMARY KEY'
        AND kcu.column_name = 'id'`,
    [tableName]
  );
  return (result.rows[0]?.c || 0) > 0;
}

async function ensureLegacyCoreColumns(client) {
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

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_party_members_user
      ON party_members(user_id);
  `);

  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_name = 'parties'
          AND constraint_name = 'parties_leader_user_id_fkey'
      ) THEN
        ALTER TABLE parties
          ADD CONSTRAINT parties_leader_user_id_fkey
          FOREIGN KEY (leader_user_id) REFERENCES users(id) ON DELETE CASCADE;
      END IF;
    END $$;
  `);
}

async function needsManagedReset(client, tableName, requiredColumns) {
  const exists = await tableExists(client, tableName);
  if (!exists) return false;

  const columns = await getPublicColumns(client, tableName);
  const missing = requiredColumns.filter((column) => !columns.includes(column));
  if (missing.length > 0) {
    console.warn(`[db] ${tableName} is missing columns: ${missing.join(', ')}`);
    return true;
  }

  if (tableName === 'queue_entries') {
    const legacyColumns = ['client_id', 'nickname', 'match_id', 'joined_at', 'updated_at', 'last_seen_ms'];
    const presentLegacy = legacyColumns.filter((column) => columns.includes(column));
    if (presentLegacy.length > 0) {
      console.warn(`[db] ${tableName} has legacy columns: ${presentLegacy.join(', ')}`);
      return true;
    }
  }

  if (tableName === 'matches') {
    const hasPk = await hasPrimaryKeyOnId(client, tableName);
    if (!hasPk) {
      console.warn('[db] matches.id is not a primary key; resetting managed tables');
      return true;
    }
  }

  return false;
}

async function dropManagedTables(client) {
  for (const tableName of RESET_ORDER) {
    await client.query(`DROP TABLE IF EXISTS ${tableName} CASCADE`);
  }
}

async function applySchema(client) {
  const schemaPath = path.join(__dirname, '../../sql/schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await client.query(sql);
}

async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

    await applySchema(client);
    await ensureLegacyCoreColumns(client);

    let shouldResetManagedTables = false;
    for (const [tableName, requiredColumns] of Object.entries(MANAGED_TABLES)) {
      if (await needsManagedReset(client, tableName, requiredColumns)) {
        shouldResetManagedTables = true;
        break;
      }
    }

    if (shouldResetManagedTables) {
      console.warn('[db] legacy managed tables detected; recreating matchmaking tables');
      await dropManagedTables(client);
      await applySchema(client);
    }

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
