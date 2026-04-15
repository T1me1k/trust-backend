const crypto = require('crypto');
const config = require('../config');
const { query, withTransaction } = require('../db');
const { createParty, getCurrentPartyByUserId } = require('./partyService');
const { setPresence } = require('./accountService');
const { assertCanQueue, getRestrictionState } = require('./restrictionsService');

function newPublicMatchId() {
  return 'match_' + crypto.randomBytes(8).toString('hex');
}

function normalizeQueueRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    partyId: row.party_id,
    leaderUserId: row.leader_user_id,
    mode: row.mode,
    status: row.status,
    queuedAt: row.queued_at,
    matchedAt: row.matched_at
  };
}

async function getQueueState(userId) {
  const result = await query(
    `SELECT qe.*
     FROM party_members pm
     JOIN queue_entries qe ON qe.party_id = pm.party_id AND qe.status = 'queued'
     WHERE pm.user_id = $1
     LIMIT 1`,
    [userId]
  );
  return normalizeQueueRow(result.rows[0] || null);
}

async function getPartyForQueue(userId) {
  let party = await getCurrentPartyByUserId(userId);
  if (!party?.id) party = await createParty(userId);
  return party;
}

async function joinQueue(userId) {
  await assertCanQueue(userId);
  const party = await getPartyForQueue(userId);
  if (!party?.id) throw new Error('party_not_found');
  if (party.leader_user_id !== userId) throw new Error('not_party_leader');
  if (party.status !== 'open') throw new Error('party_not_open');
  const memberCount = party.members.length;
  if (memberCount < 1 || memberCount > 2) throw new Error('party_size_invalid');

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO queue_entries (party_id, leader_user_id, mode, status, queued_at)
       VALUES ($1, $2, '2x2', 'queued', NOW())
       ON CONFLICT (party_id)
       DO UPDATE SET leader_user_id = EXCLUDED.leader_user_id,
                     mode = EXCLUDED.mode,
                     status = 'queued',
                     queued_at = NOW(),
                     matched_at = NULL`,
      [party.id, userId]
    );
    await client.query(
      `UPDATE parties SET status = 'searching', queue_mode = '2x2', updated_at = NOW() WHERE id = $1`,
      [party.id]
    );
  });

  for (const member of party.members) {
    await setPresence(member.userId, 'searching', party.id, null);
  }

  return getQueueState(userId);
}

async function cancelQueue(userId) {
  const party = await getCurrentPartyByUserId(userId);
  if (!party?.id) throw new Error('party_not_found');
  if (party.leader_user_id !== userId) throw new Error('not_party_leader');

  await query(`UPDATE queue_entries SET status = 'cancelled' WHERE party_id = $1 AND status = 'queued'`, [party.id]);
  await query(`UPDATE parties SET status = 'open', updated_at = NOW() WHERE id = $1`, [party.id]);

  for (const member of party.members) {
    await setPresence(member.userId, 'in_party', party.id, null);
  }
  return true;
}

async function ensureDefaultServer() {
  const result = await query(
    `SELECT * FROM server_instances WHERE status = 'idle' ORDER BY last_heartbeat_at DESC NULLS LAST, name ASC LIMIT 1`
  );
  if (result.rows[0]) return result.rows[0];

  const insert = await query(
    `INSERT INTO server_instances (name, host, port, server_password, server_token, status, region, last_heartbeat_at)
     VALUES ('default-local', $1, $2, $3, 'local-dev-token', 'idle', $4, NOW())
     ON CONFLICT (host, port) DO UPDATE SET status = 'idle'
     RETURNING *`,
    [config.defaultServerIp, config.defaultServerPort, config.defaultServerPassword, config.defaultRegion]
  );
  return insert.rows[0];
}

async function loadQueuedEntries() {
  const result = await query(
    `SELECT qe.party_id, qe.leader_user_id, qe.mode, qe.queued_at, COUNT(pm.user_id)::int AS member_count
     FROM queue_entries qe
     JOIN parties p ON p.id = qe.party_id
     JOIN party_members pm ON pm.party_id = qe.party_id
     WHERE qe.status = 'queued' AND qe.mode = '2x2' AND p.status = 'searching'
     GROUP BY qe.party_id, qe.leader_user_id, qe.mode, qe.queued_at
     HAVING COUNT(pm.user_id) BETWEEN 1 AND 2
     ORDER BY qe.queued_at ASC, qe.party_id ASC`
  );
  return result.rows.map((row) => ({ ...row, member_count: Number(row.member_count) }));
}

async function loadPartyMembers(partyId) {
  const result = await query(
    `SELECT pm.user_id, pm.role
     FROM party_members pm
     WHERE pm.party_id = $1
     ORDER BY CASE WHEN pm.role = 'leader' THEN 0 ELSE 1 END, pm.joined_at ASC`,
    [partyId]
  );
  return result.rows;
}

function pickEntriesFor2x2(entries) {
  const best = { picks: null };

  function comparePicks(a, b) {
    if (!b) return -1;
    if (a.length !== b.length) return a.length - b.length;
    const aTimes = a.map((e) => new Date(e.queued_at).getTime());
    const bTimes = b.map((e) => new Date(e.queued_at).getTime());
    for (let i = 0; i < Math.min(aTimes.length, bTimes.length); i += 1) {
      if (aTimes[i] !== bTimes[i]) return aTimes[i] - bTimes[i];
    }
    return 0;
  }

  function dfs(index, total, picks) {
    if (total === 4) {
      if (comparePicks(picks, best.picks) < 0) best.picks = [...picks];
      return;
    }
    if (total > 4 || index >= entries.length) return;
    const remainingPlayers = entries.slice(index).reduce((sum, e) => sum + e.member_count, 0);
    if (total + remainingPlayers < 4) return;

    const entry = entries[index];
    picks.push(entry);
    dfs(index + 1, total + entry.member_count, picks);
    picks.pop();
    dfs(index + 1, total, picks);
  }

  dfs(0, 0, []);
  return best.picks;
}

function assignTeams(selectedEntries) {
  const sorted = [...selectedEntries].sort((a, b) => new Date(a.queued_at) - new Date(b.queued_at) || String(a.party_id).localeCompare(String(b.party_id)));
  const duoEntries = sorted.filter((entry) => entry.member_count === 2);
  const soloEntries = sorted.filter((entry) => entry.member_count === 1);

  if (duoEntries.length === 2) {
    return [{ team: 'A', partyId: duoEntries[0].party_id }, { team: 'B', partyId: duoEntries[1].party_id }];
  }
  if (duoEntries.length === 1 && soloEntries.length === 2) {
    return [
      { team: 'A', partyId: duoEntries[0].party_id },
      { team: 'B', partyId: soloEntries[0].party_id },
      { team: 'B', partyId: soloEntries[1].party_id }
    ];
  }
  if (duoEntries.length === 0 && soloEntries.length === 4) {
    return [
      { team: 'A', partyId: soloEntries[0].party_id },
      { team: 'A', partyId: soloEntries[1].party_id },
      { team: 'B', partyId: soloEntries[2].party_id },
      { team: 'B', partyId: soloEntries[3].party_id }
    ];
  }
  return null;
}

async function createMatchFromSelection(selectedEntries) {
  const assignments = assignTeams(selectedEntries);
  if (!assignments) return null;

  const diagnostics = {
    key: 'matchmaking_diagnostics',
    selectedPartyIds: selectedEntries.map((entry) => entry.party_id),
    selectedMemberCounts: selectedEntries.map((entry) => Number(entry.member_count || 0)),
    assignments
  };

  const grouped = [];
  for (const assignment of assignments) {
    const members = await loadPartyMembers(assignment.partyId);
    if (members.length < 1 || members.length > 2) return null;
    grouped.push({ ...assignment, members });
  }

  const teamCounts = grouped.reduce((acc, group) => {
    acc[group.team] = (acc[group.team] || 0) + group.members.length;
    return acc;
  }, {});
  if (teamCounts.A !== 2 || teamCounts.B !== 2) return null;

  const server = await ensureDefaultServer();
  const publicMatchId = newPublicMatchId();
  const partyIds = grouped.map((group) => group.partyId);

  const match = await withTransaction(async (client) => {
    await client.query("SET LOCAL application_name = 'trust_matchmaker'").catch(() => {});
    await client.query(`UPDATE server_instances SET status = 'reserved', last_heartbeat_at = NOW() WHERE id = $1`, [server.id]);
    const matchResult = await client.query(
      `INSERT INTO matches (
         public_match_id, mode, status, server_id, server_ip, server_port, server_password,
         map_name, accept_expires_at, created_at
       )
       VALUES (
         $1, '2x2', 'pending_acceptance', $2, $3, $4, $5,
         NULL, NOW() + make_interval(secs => $6::int), NOW()
       )
       RETURNING *`,
      [publicMatchId, server.id, server.host, server.port, server.server_password, config.acceptTimeoutSeconds]
    );
    const row = matchResult.rows[0];

    let slotA = 0;
    let slotB = 0;
    for (const group of grouped) {
      for (const member of group.members) {
        const slotIndex = group.team === 'A' ? slotA++ : slotB++;
        await client.query(
          `INSERT INTO match_players (match_id, user_id, party_id, team, slot_index, connection_state)
           VALUES ($1, $2, $3, $4, $5, 'pending_connect')`,
          [row.id, member.user_id, group.partyId, group.team, slotIndex]
        );
      }
    }

    for (const partyId of partyIds) {
      await client.query(`UPDATE queue_entries SET status = 'matched', matched_at = NOW() WHERE party_id = $1`, [partyId]);
      await client.query(`UPDATE parties SET status = 'in_match', updated_at = NOW() WHERE id = $1`, [partyId]);
    }

    return row;
  }).catch((err) => {
    err.message = `${err.message} | ${JSON.stringify(diagnostics)}`;
    throw err;
  });

  for (const group of grouped) {
    for (const member of group.members) {
      await setPresence(member.user_id, 'in_match', group.partyId, match.id);
    }
  }

  return match;
}

async function runMatchmakingCycle() {
  const entries = await loadQueuedEntries();
  if (entries.length < 2) return null;
  const selectedEntries = pickEntriesFor2x2(entries);
  if (!selectedEntries) return null;
  return createMatchFromSelection(selectedEntries);
}


async function getPublicQueueStats() {
  const [searchingRes, activeMatchesRes] = await Promise.all([
    query(
      `SELECT COUNT(pm.user_id)::int AS searching_players
       FROM queue_entries qe
       JOIN parties p ON p.id = qe.party_id
       JOIN party_members pm ON pm.party_id = qe.party_id
       WHERE qe.status = 'queued' AND qe.mode = '2x2' AND p.status = 'searching'`
    ),
    query(
      `SELECT COUNT(*)::int AS active_matches
       FROM matches
       WHERE status IN ('pending_acceptance', 'map_voting', 'server_assigned', 'live')`
    )
  ]);

  return {
    searchingPlayers: Number(searchingRes.rows[0]?.searching_players || 0),
    activeMatches: Number(activeMatchesRes.rows[0]?.active_matches || 0)
  };
}

async function getQueueOverview(userId) {
  const [queue, restrictions] = await Promise.all([
    getQueueState(userId),
    getRestrictionState(userId)
  ]);
  return { queue, restrictions };
}

module.exports = { getQueueState, getQueueOverview, getPublicQueueStats, joinQueue, cancelQueue, runMatchmakingCycle };
