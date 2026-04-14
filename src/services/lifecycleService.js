const config = require('../config');
const { query, withTransaction } = require('../db');
const { applyPenalty } = require('./restrictionsService');
const { setPresence } = require('./accountService');

function seconds(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

async function releasePartyAndPresence(client, matchId) {
  const playersRes = await client.query(
    `SELECT user_id, party_id FROM match_players WHERE match_id = $1`,
    [matchId]
  );

  const touchedPartyIds = new Set();
  for (const row of playersRes.rows) {
    if (row.party_id) touchedPartyIds.add(row.party_id);
  }

  for (const partyId of touchedPartyIds) {
    await client.query(`UPDATE parties SET status = 'open', updated_at = NOW() WHERE id = $1`, [partyId]);
    await client.query(`UPDATE queue_entries SET status = 'cancelled' WHERE party_id = $1 AND status <> 'cancelled'`, [partyId]);
  }

  return playersRes.rows;
}

async function applyPresenceAfterMatchPlayers(players) {
  for (const row of players) {
    const nextPartyId = row.party_id || null;
    const nextState = nextPartyId ? 'in_party' : 'online';
    await setPresence(row.user_id, nextState, nextPartyId, null);
  }
}

async function expireAcceptPhase() {
  const matchesRes = await query(
    `SELECT id, public_match_id
     FROM matches
     WHERE status = 'pending_acceptance'
       AND accept_expires_at IS NOT NULL
       AND accept_expires_at <= NOW()`
  );

  for (const match of matchesRes.rows) {
    const releasedPlayers = await withTransaction(async (client) => {
      const playersRes = await client.query(
        `SELECT mp.id, mp.user_id, mp.party_id, mp.accepted_at
         FROM match_players mp
         WHERE mp.match_id = $1
         FOR UPDATE`,
        [match.id]
      );

      const pending = playersRes.rows.filter((row) => !row.accepted_at);
      if (!pending.length) return [];

      for (const row of pending) {
        await applyPenalty(client, {
          userId: row.user_id,
          penaltyType: 'accept_timeout',
          reasonKey: 'accept_timeout',
          source: 'match_lifecycle',
          matchId: match.id,
          matchPlayerId: row.id,
          metadata: { publicMatchId: match.public_match_id }
        });
      }

      await client.query(
        `UPDATE matches
         SET status = 'cancelled', finished_at = COALESCE(finished_at, NOW()), result_source = COALESCE(result_source, 'accept_timeout')
         WHERE id = $1`,
        [match.id]
      );

      if (pending.length) {
        await client.query(`UPDATE server_instances SET status = 'idle', last_heartbeat_at = NOW() WHERE id IN (SELECT server_id::uuid FROM matches WHERE id = $1 AND server_id IS NOT NULL)`, [match.id]).catch(() => {});
      }

      return releasePartyAndPresence(client, match.id);
    });

    await applyPresenceAfterMatchPlayers(releasedPlayers);
  }

  return matchesRes.rowCount;
}

async function finalizeMapVotingTimeouts() {
  const timeoutSeconds = seconds(config.mapVoteTimeoutSeconds, 35);
  const matchesRes = await query(
    `SELECT m.id, m.public_match_id
     FROM matches m
     WHERE m.status = 'map_voting'
       AND m.map_name IS NULL
       AND m.map_voting_started_at IS NOT NULL
       AND m.map_voting_started_at + make_interval(secs => $1::int) <= NOW()`,
    [timeoutSeconds]
  );

  for (const match of matchesRes.rows) {
    await withTransaction(async (client) => {
      const votesRes = await client.query(`SELECT map_vote, accepted_at FROM match_players WHERE match_id = $1 FOR UPDATE`, [match.id]);
      const votes = votesRes.rows.map((row) => row.map_vote).filter(Boolean);
      const order = ['shortdust', 'lake', 'overpass', 'vertigo', 'nuke'];
      const counts = new Map(order.map((map) => [map, 0]));
      for (const vote of votes) counts.set(vote, (counts.get(vote) || 0) + 1);
      let selectedMap = order[0];
      let bestCount = -1;
      for (const map of order) {
        const count = counts.get(map) || 0;
        if (count > bestCount) {
          bestCount = count;
          selectedMap = map;
        }
      }

      await client.query(
        `UPDATE matches
         SET map_name = COALESCE(map_name, $2),
             map_voting_finished_at = COALESCE(map_voting_finished_at, NOW()),
             selected_map_by = COALESCE(selected_map_by, 'timeout_fallback'),
             status = 'server_assigned'
         WHERE id = $1`,
        [match.id, selectedMap]
      );
    });
  }

  return matchesRes.rowCount;
}

async function expireConnectPhase() {
  const matchesRes = await query(
    `SELECT id, public_match_id
     FROM matches
     WHERE status = 'server_assigned'
       AND connect_expires_at IS NOT NULL
       AND connect_expires_at <= NOW()`
  );

  for (const match of matchesRes.rows) {
    const releasedPlayers = await withTransaction(async (client) => {
      const playersRes = await client.query(
        `SELECT mp.id, mp.user_id, mp.party_id, mp.connection_state
         FROM match_players mp
         WHERE mp.match_id = $1
         FOR UPDATE`,
        [match.id]
      );

      const offenders = playersRes.rows.filter((row) => row.connection_state !== 'connected');
      if (!offenders.length) return [];

      for (const row of offenders) {
        await applyPenalty(client, {
          userId: row.user_id,
          penaltyType: 'no_connect',
          reasonKey: 'no_connect_after_accept',
          source: 'match_lifecycle',
          matchId: match.id,
          matchPlayerId: row.id,
          metadata: { publicMatchId: match.public_match_id }
        });
      }

      await client.query(
        `UPDATE matches
         SET status = 'cancelled', finished_at = COALESCE(finished_at, NOW()), result_source = COALESCE(result_source, 'connect_timeout')
         WHERE id = $1`,
        [match.id]
      );

      await client.query(
        `UPDATE server_instances
         SET status = 'idle', last_heartbeat_at = NOW()
         WHERE id IN (SELECT server_id::uuid FROM matches WHERE id = $1 AND server_id IS NOT NULL)`,
        [match.id]
      ).catch(() => {});

      return releasePartyAndPresence(client, match.id);
    });

    await applyPresenceAfterMatchPlayers(releasedPlayers);
  }

  return matchesRes.rowCount;
}

async function expireLiveReconnects() {
  const expiredRes = await query(
    `SELECT mp.id, mp.user_id, mp.match_id, m.public_match_id
     FROM match_players mp
     JOIN matches m ON m.id = mp.match_id
     WHERE m.status = 'live'
       AND mp.connection_state = 'disconnected'
       AND mp.reconnect_expires_at IS NOT NULL
       AND mp.reconnect_expires_at <= NOW()
       AND mp.abandoned_at IS NULL`
  );

  for (const row of expiredRes.rows) {
    await withTransaction(async (client) => {
      const lockRes = await client.query(
        `SELECT mp.id, mp.user_id, mp.abandoned_at
         FROM match_players mp
         WHERE mp.id = $1
         FOR UPDATE`,
        [row.id]
      );
      const locked = lockRes.rows[0];
      if (!locked || locked.abandoned_at) return;

      await client.query(
        `UPDATE match_players
         SET connection_state = 'abandoned',
             abandoned_at = COALESCE(abandoned_at, NOW())
         WHERE id = $1`,
        [row.id]
      );

      await applyPenalty(client, {
        userId: row.user_id,
        penaltyType: 'abandon',
        reasonKey: 'left_live_match',
        source: 'match_lifecycle',
        matchId: row.match_id,
        matchPlayerId: row.id,
        metadata: { publicMatchId: row.public_match_id }
      });
    });
  }

  return expiredRes.rowCount;
}

async function runLifecycleTick() {
  const [acceptExpired, mapTimeouts, connectExpired, abandonExpired] = await Promise.all([
    expireAcceptPhase(),
    finalizeMapVotingTimeouts(),
    expireConnectPhase(),
    expireLiveReconnects()
  ]);

  return { acceptExpired, mapTimeouts, connectExpired, abandonExpired };
}

module.exports = { runLifecycleTick };
