const { query } = require('../db');
const { ensurePlayerProfile } = require('./accountService');

function buildStreaks(resultsAsc) {
  let bestWin = 0;
  let currentWin = 0;
  let runningWin = 0;

  for (const item of resultsAsc) {
    if (item === 'win') {
      runningWin += 1;
      if (runningWin > bestWin) bestWin = runningWin;
    } else {
      runningWin = 0;
    }
  }

  for (let i = resultsAsc.length - 1; i >= 0; i -= 1) {
    if (resultsAsc[i] === 'win') currentWin += 1;
    else break;
  }

  return { bestWinStreak: bestWin, currentWinStreak: currentWin };
}

function standingFromWinRate(winRate, matchesPlayed) {
  if (matchesPlayed >= 20 && winRate >= 62) return 'hot';
  if (matchesPlayed >= 8 && winRate >= 50) return 'good';
  return 'building';
}

async function getProfileSummaryByUserId(userId) {
  await ensurePlayerProfile(userId);

  const baseResult = await query(
    `SELECT
        u.id,
        u.steam_id,
        u.persona_name,
        u.profile_url,
        u.avatar_url,
        u.avatar_medium_url,
        u.avatar_full_url,
        COALESCE(pp.elo_2v2, 100) AS elo_2v2,
        COALESCE(pp.wins_2v2, 0) AS wins_2v2,
        COALESCE(pp.losses_2v2, 0) AS losses_2v2,
        COALESCE(pp.matches_played_2v2, 0) AS matches_played_2v2,
        pp.last_match_at
     FROM users u
     LEFT JOIN player_profiles pp ON pp.user_id = u.id
     WHERE u.id = $1
     LIMIT 1`,
    [userId]
  );

  const base = baseResult.rows[0] || null;
  if (!base) return null;

  const recentResult = await query(
    `SELECT m.map_name, mp.result, m.finished_at, m.created_at
     FROM match_players mp
     JOIN matches m ON m.id = mp.match_id
     WHERE mp.user_id = $1
       AND m.status = 'finished'
       AND mp.result IN ('win', 'loss')
     ORDER BY COALESCE(m.finished_at, m.created_at) DESC
     LIMIT 20`,
    [userId]
  );

  const recent = recentResult.rows;
  const recentResultsAsc = [...recent].reverse().map((row) => row.result);
  const streaks = buildStreaks(recentResultsAsc);
  const recentForm = recent.slice(0, 10).map((row) => row.result === 'win' ? 'W' : 'L');

  const favoriteMapResult = await query(
    `SELECT m.map_name, COUNT(*)::int AS matches, SUM(CASE WHEN mp.result = 'win' THEN 1 ELSE 0 END)::int AS wins
     FROM match_players mp
     JOIN matches m ON m.id = mp.match_id
     WHERE mp.user_id = $1
       AND m.status = 'finished'
       AND m.map_name IS NOT NULL
     GROUP BY m.map_name
     ORDER BY COUNT(*) DESC, SUM(CASE WHEN mp.result = 'win' THEN 1 ELSE 0 END) DESC, m.map_name ASC
     LIMIT 1`,
    [userId]
  );

  const favoriteMap = favoriteMapResult.rows[0] || null;
  const wins = Number(base.wins_2v2 || 0);
  const losses = Number(base.losses_2v2 || 0);
  const matchesPlayed = Number(base.matches_played_2v2 || 0);
  const completedMatches = wins + losses;
  const winRate = completedMatches > 0 ? Math.round((wins / completedMatches) * 100) : 0;

  return {
    id: base.id,
    steamId: base.steam_id,
    steamId64: base.steam_id,
    nickname: base.persona_name,
    avatarUrl: base.avatar_full_url || base.avatar_medium_url || base.avatar_url || null,
    profileUrl: base.profile_url || null,
    elo2v2: Number(base.elo_2v2 || 100),
    wins2v2: wins,
    losses2v2: losses,
    matchesPlayed2v2: matchesPlayed,
    completedMatches2v2: completedMatches,
    winRate2v2: winRate,
    currentWinStreak: streaks.currentWinStreak,
    bestWinStreak: streaks.bestWinStreak,
    favoriteMap: favoriteMap?.map_name || null,
    favoriteMapMatches: Number(favoriteMap?.matches || 0),
    recentForm,
    standing: standingFromWinRate(winRate, matchesPlayed),
    lastMatchAt: base.last_match_at || null
  };
}

async function getProfileHistoryByUserId(userId, limit = 12) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 12, 30));
  const result = await query(
    `SELECT
        m.id,
        m.public_match_id,
        m.mode,
        m.status,
        m.map_name,
        m.team_a_score,
        m.team_b_score,
        m.winner_team,
        m.server_ip,
        m.server_port,
        COALESCE(m.finished_at, m.created_at) AS sort_at,
        m.started_at,
        m.finished_at,
        m.created_at,
        mp.team,
        mp.elo_before,
        mp.elo_after,
        mp.elo_delta,
        mp.result
     FROM match_players mp
     JOIN matches m ON m.id = mp.match_id
     WHERE mp.user_id = $1
       AND m.status = 'finished'
     ORDER BY COALESCE(m.finished_at, m.created_at) DESC
     LIMIT $2`,
    [userId, safeLimit]
  );

  const matches = result.rows;
  if (!matches.length) return [];

  const matchIds = matches.map((row) => row.id);
  const participants = await query(
    `SELECT
        mp.match_id,
        mp.user_id,
        mp.team,
        mp.result,
        u.persona_name,
        u.avatar_full_url,
        COALESCE(pp.elo_2v2, 100) AS elo_2v2
     FROM match_players mp
     JOIN users u ON u.id = mp.user_id
     LEFT JOIN player_profiles pp ON pp.user_id = u.id
     WHERE mp.match_id = ANY($1::uuid[])
     ORDER BY mp.match_id, mp.team, u.persona_name`,
    [matchIds]
  );

  const byMatch = new Map();
  for (const row of participants.rows) {
    const list = byMatch.get(row.match_id) || [];
    list.push({
      userId: row.user_id,
      team: row.team,
      result: row.result,
      nickname: row.persona_name,
      avatarUrl: row.avatar_full_url || null,
      elo2v2: Number(row.elo_2v2 || 100)
    });
    byMatch.set(row.match_id, list);
  }

  return matches.map((row) => {
    const players = byMatch.get(row.id) || [];
    const teammate = players.find((p) => p.team === row.team && p.userId !== userId) || null;
    const opponents = players.filter((p) => p.team !== row.team);
    const durationSec = row.started_at && row.finished_at
      ? Math.max(0, Math.round((new Date(row.finished_at) - new Date(row.started_at)) / 1000))
      : null;

    return {
      publicMatchId: row.public_match_id,
      mode: row.mode,
      status: row.status,
      mapName: row.map_name,
      finishedAt: row.finished_at || row.sort_at,
      createdAt: row.created_at,
      startedAt: row.started_at,
      durationSec,
      team: row.team,
      result: row.result,
      winnerTeam: row.winner_team,
      teamAScore: Number(row.team_a_score || 0),
      teamBScore: Number(row.team_b_score || 0),
      eloBefore: row.elo_before == null ? null : Number(row.elo_before),
      eloAfter: row.elo_after == null ? null : Number(row.elo_after),
      eloDelta: row.elo_delta == null ? null : Number(row.elo_delta),
      teammate,
      opponents
    };
  });
}

async function getMatchDetailsForUser({ publicMatchId, viewerUserId }) {
  const membership = await query(
    `SELECT m.id, m.public_match_id, m.mode, m.status, m.map_name, m.server_ip, m.server_port, m.server_password,
            m.team_a_score, m.team_b_score, m.winner_team, m.accepted_at, m.map_voting_started_at,
            m.map_voting_finished_at, m.started_at, m.finished_at, m.created_at,
            si.name AS server_name, si.region AS server_region
     FROM matches m
     JOIN match_players my ON my.match_id = m.id
     LEFT JOIN server_instances si ON si.id::text = m.server_id
     WHERE m.public_match_id = $1 AND my.user_id = $2
     LIMIT 1`,
    [publicMatchId, viewerUserId]
  );

  const match = membership.rows[0] || null;
  if (!match) return null;

  const participants = await query(
    `SELECT mp.user_id, mp.team, mp.slot_index, mp.accepted_at, mp.map_vote, mp.elo_before, mp.elo_after, mp.elo_delta, mp.result,
            u.persona_name, u.avatar_full_url, COALESCE(pp.elo_2v2, 100) AS elo_2v2
     FROM match_players mp
     JOIN users u ON u.id = mp.user_id
     LEFT JOIN player_profiles pp ON pp.user_id = u.id
     WHERE mp.match_id = $1
     ORDER BY mp.team, mp.slot_index`,
    [match.id]
  );

  const players = participants.rows.map((row) => ({
    userId: row.user_id,
    team: row.team,
    slotIndex: Number(row.slot_index || 0),
    nickname: row.persona_name,
    avatarUrl: row.avatar_full_url || null,
    elo2v2: Number(row.elo_2v2 || 100),
    accepted: !!row.accepted_at,
    mapVote: row.map_vote || null,
    eloBefore: row.elo_before == null ? null : Number(row.elo_before),
    eloAfter: row.elo_after == null ? null : Number(row.elo_after),
    eloDelta: row.elo_delta == null ? null : Number(row.elo_delta),
    result: row.result || null
  }));

  return {
    publicMatchId: match.public_match_id,
    mode: match.mode,
    status: match.status,
    mapName: match.map_name,
    server: {
      name: match.server_name || null,
      region: match.server_region || null,
      ip: match.server_ip || null,
      port: match.server_port == null ? null : Number(match.server_port),
      password: match.server_password || null
    },
    score: {
      teamA: Number(match.team_a_score || 0),
      teamB: Number(match.team_b_score || 0),
      winnerTeam: match.winner_team || null
    },
    timeline: {
      acceptedAt: match.accepted_at || null,
      mapVotingStartedAt: match.map_voting_started_at || null,
      mapVotingFinishedAt: match.map_voting_finished_at || null,
      startedAt: match.started_at || null,
      finishedAt: match.finished_at || null,
      createdAt: match.created_at || null
    },
    teams: {
      A: players.filter((p) => p.team === 'A'),
      B: players.filter((p) => p.team === 'B')
    }
  };
}

module.exports = {
  getProfileSummaryByUserId,
  getProfileHistoryByUserId,
  getMatchDetailsForUser
};
