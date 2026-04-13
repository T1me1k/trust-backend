const config = require('../config');
const { query, withTransaction } = require('../db');
const { applySimpleMatchElo } = require('./eloService');
const { setPresence } = require('./accountService');
const { applyPenalty } = require('./restrictionsService');

const MAP_POOL = ['shortdust', 'lake', 'overpass', 'vertigo', 'nuke'];

function determineSelectedMap(votes) {
  if (!votes.length) return null;
  const counts = new Map();
  for (const vote of votes) counts.set(vote, (counts.get(vote) || 0) + 1);
  let bestMap = null;
  let bestCount = -1;
  for (const map of MAP_POOL) {
    const count = counts.get(map) || 0;
    if (count > bestCount) {
      bestCount = count;
      bestMap = map;
    }
  }
  return bestMap;
}

async function releasePreLiveMatch(client, matchId, serverId) {
  const playersResult = await client.query(`SELECT user_id, party_id FROM match_players WHERE match_id = $1`, [matchId]);
  const partyIds = [...new Set(playersResult.rows.map((row) => row.party_id).filter(Boolean))];

  await client.query(
    `UPDATE matches SET status = 'cancelled', finished_at = COALESCE(finished_at, NOW()) WHERE id = $1`,
    [matchId]
  );

  if (serverId) {
    await client.query(`UPDATE server_instances SET status = 'idle', last_heartbeat_at = NOW() WHERE id = $1`, [serverId]);
  }

  for (const partyId of partyIds) {
    await client.query(`UPDATE parties SET status = 'open', updated_at = NOW() WHERE id = $1`, [partyId]);
    await client.query(`UPDATE queue_entries SET status = 'cancelled' WHERE party_id = $1 AND status <> 'cancelled'`, [partyId]);
  }

  return playersResult.rows;
}

async function restorePresenceAfterMatchFlow(players) {
  for (const row of players) {
    const nextPartyId = row.party_id || null;
    const nextState = nextPartyId ? 'in_party' : 'online';
    await setPresence(row.user_id, nextState, nextPartyId, null);
  }
}

function secondsRemaining(value) {
  if (!value) return null;
  return Math.max(0, Math.ceil((new Date(value).getTime() - Date.now()) / 1000));
}

async function getCurrentMatchByUserId(userId) {
  const result = await query(
    `SELECT m.id, m.public_match_id, m.mode, m.status, m.map_name, m.server_ip, m.server_port, m.server_password,
            m.team_a_score, m.team_b_score, m.winner_team, m.accept_expires_at, m.connect_expires_at,
            mp.team, mp.accepted_at AS player_accepted_at, mp.map_vote AS player_map_vote,
            mp.connected_at AS player_connected_at, mp.disconnected_at AS player_disconnected_at,
            mp.reconnect_expires_at AS player_reconnect_expires_at, mp.abandoned_at AS player_abandoned_at,
            mp.connection_state AS player_connection_state
     FROM match_players mp
     JOIN matches m ON m.id = mp.match_id
     WHERE mp.user_id = $1 AND m.status IN ('pending_acceptance', 'map_voting', 'server_assigned', 'live')
     ORDER BY m.created_at DESC
     LIMIT 1`,
    [userId]
  );
  const match = result.rows[0] || null;
  if (!match) return null;

  const playersResult = await query(
    `SELECT u.persona_name AS nickname, u.avatar_full_url AS avatar_url, p.elo_2v2, mp.team, mp.slot_index,
            mp.accepted_at, mp.map_vote, mp.user_id, mp.connected_at, mp.disconnected_at,
            mp.reconnect_expires_at, mp.abandoned_at, mp.connection_state
     FROM match_players mp
     JOIN users u ON u.id = mp.user_id
     LEFT JOIN player_profiles p ON p.user_id = u.id
     WHERE mp.match_id = $1
     ORDER BY mp.team, mp.slot_index`,
    [match.id]
  );

  const players = playersResult.rows.map((row) => ({
    userId: row.user_id,
    nickname: row.nickname,
    avatarUrl: row.avatar_url || null,
    elo: Number(row.elo_2v2 || 100),
    team: row.team,
    slotIndex: row.slot_index,
    accepted: !!row.accepted_at,
    mapVote: row.map_vote || null,
    connected: !!row.connected_at && !row.abandoned_at,
    disconnectedAt: row.disconnected_at,
    reconnectExpiresAt: row.reconnect_expires_at,
    abandonedAt: row.abandoned_at,
    connectionState: row.connection_state
  }));

  const acceptedCount = players.filter((p) => p.accepted).length;
  const votes = players.map((p) => p.mapVote).filter(Boolean);
  const connectedCount = players.filter((p) => p.connected).length;

  return {
    matchId: match.public_match_id,
    publicMatchId: match.public_match_id,
    mode: match.mode,
    status: match.status,
    mapName: match.map_name,
    serverIp: match.server_ip,
    serverPort: match.server_port,
    serverPassword: match.server_password,
    teamAScore: Number(match.team_a_score || 0),
    teamBScore: Number(match.team_b_score || 0),
    winnerTeam: match.winner_team,
    team: match.team,
    accepted: !!match.player_accepted_at,
    acceptedCount,
    totalPlayers: players.length,
    mapVote: match.player_map_vote || null,
    mapVotesCount: votes.length,
    connectedCount,
    acceptExpiresAt: match.accept_expires_at,
    connectExpiresAt: match.connect_expires_at,
    reconnectExpiresAt: match.player_reconnect_expires_at,
    playerConnectionState: match.player_connection_state,
    mapPool: MAP_POOL,
    players,
    timers: {
      acceptRemainingSec: secondsRemaining(match.accept_expires_at),
      connectRemainingSec: secondsRemaining(match.connect_expires_at),
      reconnectRemainingSec: secondsRemaining(match.player_reconnect_expires_at)
    }
  };
}

async function getMatchHistory(userId, limit = 8) {
  const result = await query(
    `SELECT m.public_match_id, m.mode, m.status, m.map_name, m.team_a_score, m.team_b_score, m.winner_team, m.finished_at,
            mp.team, mp.elo_before, mp.elo_after, mp.elo_delta, mp.result
     FROM match_players mp
     JOIN matches m ON m.id = mp.match_id
     WHERE mp.user_id = $1 AND m.status = 'finished'
     ORDER BY m.finished_at DESC NULLS LAST, m.created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

async function acceptCurrentMatch(userId, publicMatchId) {
  return withTransaction(async (client) => {
    const current = await client.query(
      `SELECT m.id, m.status, m.map_name, mp.accepted_at
       FROM matches m
       JOIN match_players mp ON mp.match_id = m.id
       WHERE m.public_match_id = $1 AND mp.user_id = $2
       LIMIT 1
       FOR UPDATE`,
      [publicMatchId, userId]
    );
    const row = current.rows[0];
    if (!row) throw new Error('match_not_found');
    if (!['pending_acceptance', 'map_voting', 'server_assigned'].includes(row.status)) throw new Error('match_not_accepting');

    if (!row.accepted_at) {
      await client.query(`UPDATE match_players SET accepted_at = NOW() WHERE match_id = $1 AND user_id = $2`, [row.id, userId]);
    }

    const counts = await client.query(
      `SELECT COUNT(*)::int AS total, COUNT(accepted_at)::int AS accepted
       FROM match_players WHERE match_id = $1`,
      [row.id]
    );
    const total = counts.rows[0].total;
    const accepted = counts.rows[0].accepted;

    if (accepted === total) {
      await client.query(
        `UPDATE matches
         SET status = CASE WHEN map_name IS NULL THEN 'map_voting' ELSE 'server_assigned' END,
             accepted_at = COALESCE(accepted_at, NOW()),
             map_voting_started_at = CASE WHEN map_name IS NULL THEN COALESCE(map_voting_started_at, NOW()) ELSE map_voting_started_at END,
             connect_expires_at = CASE WHEN map_name IS NOT NULL THEN COALESCE(connect_expires_at, NOW() + ($2 * INTERVAL '1 second')) ELSE connect_expires_at END
         WHERE id = $1`,
        [row.id, config.connectTimeoutSeconds]
      );
    }

    return { accepted, total };
  });
}

async function submitMapVote(userId, publicMatchId, mapName) {
  if (!MAP_POOL.includes(mapName)) throw new Error('invalid_map');

  return withTransaction(async (client) => {
    const matchResult = await client.query(
      `SELECT m.id, m.status
       FROM matches m
       JOIN match_players mp ON mp.match_id = m.id
       WHERE m.public_match_id = $1 AND mp.user_id = $2
       LIMIT 1
       FOR UPDATE`,
      [publicMatchId, userId]
    );
    const match = matchResult.rows[0];
    if (!match) throw new Error('match_not_found');
    if (!['map_voting', 'server_assigned'].includes(match.status)) throw new Error('map_voting_not_started');

    await client.query(
      `UPDATE match_players
       SET map_vote = $3, map_vote_at = NOW(), accepted_at = COALESCE(accepted_at, NOW())
       WHERE match_id = $1 AND user_id = $2`,
      [match.id, userId, mapName]
    );

    const players = await client.query(`SELECT map_vote FROM match_players WHERE match_id = $1`, [match.id]);

    const votes = players.rows.map((r) => r.map_vote).filter(Boolean);
    let selectedMap = null;
    if (votes.length >= 4) selectedMap = determineSelectedMap(votes);

    if (!selectedMap) {
      const maybeMajority = determineSelectedMap(votes);
      const count = votes.filter((v) => v === maybeMajority).length;
      if (count >= 3) selectedMap = maybeMajority;
    }

    if (selectedMap) {
      await client.query(
        `UPDATE matches
         SET map_name = $2,
             map_voting_finished_at = NOW(),
             selected_map_by = 'player_votes',
             status = 'server_assigned',
             connect_expires_at = COALESCE(connect_expires_at, NOW() + ($3 * INTERVAL '1 second'))
         WHERE id = $1`,
        [match.id, selectedMap, config.connectTimeoutSeconds]
      );
    }

    return { selectedMap };
  });
}

async function markPlayerConnected({ publicMatchId, steamId }) {
  return withTransaction(async (client) => {
    const rowResult = await client.query(
      `SELECT mp.id AS match_player_id, mp.match_id, mp.user_id, m.status
       FROM match_players mp
       JOIN matches m ON m.id = mp.match_id
       JOIN users u ON u.id = mp.user_id
       WHERE m.public_match_id = $1 AND u.steam_id = $2
       LIMIT 1
       FOR UPDATE`,
      [publicMatchId, steamId]
    );
    const row = rowResult.rows[0];
    if (!row) throw new Error('match_player_not_found');

    await client.query(
      `UPDATE match_players
       SET connected_at = NOW(),
           disconnected_at = NULL,
           reconnect_expires_at = NULL,
           connection_state = 'connected'
       WHERE id = $1`,
      [row.match_player_id]
    );

    if (['server_assigned', 'live'].includes(row.status)) {
      await client.query(
        `UPDATE matches SET status = CASE WHEN status = 'server_assigned' THEN 'live' ELSE status END,
                           started_at = CASE WHEN started_at IS NULL THEN NOW() ELSE started_at END
         WHERE id = $1`,
        [row.match_id]
      );
    }

    return { ok: true };
  });
}

async function markPlayerDisconnected({ publicMatchId, steamId }) {
  return withTransaction(async (client) => {
    const rowResult = await client.query(
      `SELECT mp.id AS match_player_id, mp.match_id, m.status
       FROM match_players mp
       JOIN matches m ON m.id = mp.match_id
       JOIN users u ON u.id = mp.user_id
       WHERE m.public_match_id = $1 AND u.steam_id = $2
       LIMIT 1
       FOR UPDATE`,
      [publicMatchId, steamId]
    );
    const row = rowResult.rows[0];
    if (!row) throw new Error('match_player_not_found');
    if (row.status !== 'live') return { ignored: true };

    await client.query(
      `UPDATE match_players
       SET disconnected_at = NOW(),
           reconnect_expires_at = NOW() + ($2 * INTERVAL '1 second'),
           connection_state = 'disconnected'
       WHERE id = $1 AND abandoned_at IS NULL`,
      [row.match_player_id, config.reconnectGraceSeconds]
    );

    return { ok: true };
  });
}

async function submitMatchResult({ publicMatchId, winnerTeam, teamAScore, teamBScore, mapName, resultSource = 'server_plugin' }) {
  const matchResult = await query(`SELECT id, status, server_id FROM matches WHERE public_match_id = $1 LIMIT 1`, [publicMatchId]);
  const match = matchResult.rows[0];
  if (!match) throw new Error('match_not_found');
  if (match.status === 'finished') return { alreadyFinished: true };

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE matches
       SET status = 'finished', winner_team = $2, team_a_score = $3, team_b_score = $4,
           map_name = COALESCE($5, map_name), result_source = $6, finished_at = NOW()
       WHERE id = $1`,
      [match.id, winnerTeam, teamAScore, teamBScore, mapName || null, resultSource]
    );

    if (match.server_id) {
      await client.query(`UPDATE server_instances SET status = 'idle', last_heartbeat_at = NOW() WHERE id = $1`, [match.server_id]);
    }
  });

  await applySimpleMatchElo(match.id, winnerTeam);

  const players = await query(`SELECT user_id, party_id FROM match_players WHERE match_id = $1`, [match.id]);
  const touchedPartyIds = new Set();
  for (const row of players.rows) if (row.party_id) touchedPartyIds.add(row.party_id);

  for (const row of players.rows) {
    const nextPartyId = row.party_id || null;
    const nextState = nextPartyId ? 'in_party' : 'online';
    await setPresence(row.user_id, nextState, nextPartyId, null);
  }

  for (const partyId of touchedPartyIds) {
    await query(`UPDATE parties SET status = 'open', updated_at = NOW() WHERE id = $1`, [partyId]);
    await query(`UPDATE queue_entries SET status = 'cancelled' WHERE party_id = $1 AND status <> 'cancelled'`, [partyId]);
  }

  return { alreadyFinished: false };
}

async function processMatchLifecycleCycle() {
  let changed = 0;

  const acceptExpired = await query(
    `SELECT m.id, m.server_id
     FROM matches m
     WHERE m.status = 'pending_acceptance'
       AND m.accept_expires_at IS NOT NULL
       AND m.accept_expires_at <= NOW()`
  );

  for (const match of acceptExpired.rows) {
    const releasedPlayers = await withTransaction(async (client) => {
      const offenders = await client.query(
        `SELECT mp.id, mp.user_id
         FROM match_players mp
         WHERE mp.match_id = $1 AND mp.accepted_at IS NULL
         FOR UPDATE`,
        [match.id]
      );
      for (const offender of offenders.rows) {
        await applyPenalty(client, {
          userId: offender.user_id,
          penaltyType: 'accept_timeout',
          reasonKey: 'accept_timeout',
          source: 'match_accept_timeout',
          matchId: match.id,
          matchPlayerId: offender.id,
          metadata: { stage: 'accept' }
        });
      }
      return releasePreLiveMatch(client, match.id, match.server_id);
    });
    await restorePresenceAfterMatchFlow(releasedPlayers);
    changed += 1;
  }

  const connectExpired = await query(
    `SELECT m.id, m.server_id
     FROM matches m
     WHERE m.status = 'server_assigned'
       AND m.connect_expires_at IS NOT NULL
       AND m.connect_expires_at <= NOW()`
  );

  for (const match of connectExpired.rows) {
    const releasedPlayers = await withTransaction(async (client) => {
      const offenders = await client.query(
        `SELECT mp.id, mp.user_id
         FROM match_players mp
         WHERE mp.match_id = $1 AND mp.connected_at IS NULL
         FOR UPDATE`,
        [match.id]
      );
      for (const offender of offenders.rows) {
        await applyPenalty(client, {
          userId: offender.user_id,
          penaltyType: 'no_connect',
          reasonKey: 'failed_to_connect_after_accept',
          source: 'match_connect_timeout',
          matchId: match.id,
          matchPlayerId: offender.id,
          metadata: { stage: 'server_assigned' }
        });
      }
      return releasePreLiveMatch(client, match.id, match.server_id);
    });
    await restorePresenceAfterMatchFlow(releasedPlayers);
    changed += 1;
  }

  const reconnectExpired = await query(
    `SELECT mp.id, mp.user_id, mp.match_id
     FROM match_players mp
     JOIN matches m ON m.id = mp.match_id
     WHERE m.status = 'live'
       AND mp.connection_state = 'disconnected'
       AND mp.abandoned_at IS NULL
       AND mp.reconnect_expires_at IS NOT NULL
       AND mp.reconnect_expires_at <= NOW()`
  );

  for (const row of reconnectExpired.rows) {
    await withTransaction(async (client) => {
      const current = await client.query(
        `SELECT id FROM match_players
         WHERE id = $1 AND abandoned_at IS NULL AND connection_state = 'disconnected'
         FOR UPDATE`,
        [row.id]
      );
      if (!current.rows[0]) return;
      await client.query(
        `UPDATE match_players
         SET abandoned_at = NOW(), connection_state = 'abandoned'
         WHERE id = $1`,
        [row.id]
      );
      await applyPenalty(client, {
        userId: row.user_id,
        penaltyType: 'abandon',
        reasonKey: 'reconnect_grace_expired',
        source: 'live_match_abandon',
        matchId: row.match_id,
        matchPlayerId: row.id,
        metadata: { stage: 'live' }
      });
    });
    changed += 1;
  }

  return { changed };
}

module.exports = {
  MAP_POOL,
  getCurrentMatchByUserId,
  getMatchHistory,
  acceptCurrentMatch,
  submitMapVote,
  markPlayerConnected,
  markPlayerDisconnected,
  submitMatchResult,
  processMatchLifecycleCycle
};
