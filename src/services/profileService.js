const { query } = require('../db');
const { ensurePlayerProfile } = require('./accountService');
const { getRankForElo } = require('./rankService');

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
  const elo2v2 = Number(base.elo_2v2 || 100);

  const leaderboardPositionResult = await query(
    `SELECT 1 + COUNT(*)::int AS position
     FROM player_profiles
     WHERE COALESCE(elo_2v2, 100) > $1`,
    [elo2v2]
  );
  const leaderboardPosition = Number(leaderboardPositionResult.rows[0]?.position || 1);
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
    elo2v2,
    rank: getRankForElo(elo2v2),
    wins2v2: wins,
    losses2v2: losses,
    matchesPlayed2v2: matchesPlayed,
    completedMatches2v2: completedMatches,
    winRate2v2: winRate,
    currentWinStreak: streaks.currentWinStreak,
    bestWinStreak: streaks.bestWinStreak,
    favoriteMap: favoriteMap?.map_name || null,
    favoriteMapMatches: Number(favoriteMap?.matches || 0),
    leaderboardPosition,
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
      elo2v2: Number(row.elo_2v2 || 100),
      rank: getRankForElo(Number(row.elo_2v2 || 100))
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
    rank: getRankForElo(Number(row.elo_2v2 || 100)),
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


function buildPlayerMatchStats(row) {
  return {
    kills: Number(row.kills || 0), deaths: Number(row.deaths || 0), assists: Number(row.assists || 0),
    headshots: Number(row.headshots || 0), damage: Number(row.damage || 0), mvps: Number(row.mvps || 0),
    firstKills: Number(row.first_kills || 0), clutches: Number(row.clutches || 0),
    performanceScore: Number(row.performance_score || 0)
  };
}

async function getMatchDetails(publicMatchId) {
  const matchRes = await query(
    `SELECT m.id, m.public_match_id, m.mode, m.status, m.map_name, m.team_a_score, m.team_b_score, m.winner_team,
            m.started_at, m.finished_at, m.created_at, m.duration_seconds, m.server_id, si.name AS server_name, si.region AS server_region
     FROM matches m LEFT JOIN server_instances si ON si.id::text = m.server_id
     WHERE m.public_match_id = $1 LIMIT 1`, [publicMatchId]
  );
  const match = matchRes.rows[0] || null;
  if (!match) return null;
  const playersRes = await query(
    `SELECT mp.*, u.steam_id, u.persona_name, u.avatar_full_url, COALESCE(pp.elo_2v2,100) AS elo_2v2
     FROM match_players mp JOIN users u ON u.id=mp.user_id LEFT JOIN player_profiles pp ON pp.user_id=mp.user_id
     WHERE mp.match_id=$1 ORDER BY mp.team, mp.slot_index`, [match.id]
  );
  const roundsRes = await query(
    `SELECT round_number, winner_team, reason, team_a_score, team_b_score, duration_seconds FROM match_rounds WHERE match_id=$1 ORDER BY round_number`, [match.id]
  );
  const players = playersRes.rows.map((row) => ({
    userId: row.user_id, steamId: row.steam_id, team: row.team, slotIndex: Number(row.slot_index || 0),
    nickname: row.persona_name, avatarUrl: row.avatar_full_url || null,
    rank: getRankForElo(Number(row.elo_after || row.elo_2v2 || 100)),
    eloBefore: row.elo_before == null ? null : Number(row.elo_before), eloAfter: row.elo_after == null ? null : Number(row.elo_after),
    eloDelta: row.elo_delta == null ? null : Number(row.elo_delta), result: row.result || null,
    stats: buildPlayerMatchStats(row), isMatchMvp: !!row.is_match_mvp
  }));
  return {
    matchId: match.public_match_id, publicMatchId: match.public_match_id, mode: match.mode, status: match.status,
    map: match.map_name || null, mapName: match.map_name || null, durationSeconds: match.duration_seconds == null ? null : Number(match.duration_seconds),
    startedAt: match.started_at || null, finishedAt: match.finished_at || null, createdAt: match.created_at || null,
    server: { id: match.server_id || null, name: match.server_name || null, region: match.server_region || null },
    score: { teamA: Number(match.team_a_score || 0), teamB: Number(match.team_b_score || 0), winnerTeam: match.winner_team || null },
    teams: { A: players.filter((p)=>p.team==='A'), B: players.filter((p)=>p.team==='B') }, players,
    rounds: roundsRes.rows.map((r)=>({ roundNumber:Number(r.round_number), winnerTeam:r.winner_team, reason:r.reason, teamAScore:Number(r.team_a_score||0), teamBScore:Number(r.team_b_score||0), durationSeconds:r.duration_seconds==null?null:Number(r.duration_seconds) }))
  };
}

async function getPlayerMatchHistoryBySteamId(steamId, page = 1, limit = 20) {
  const safePage = Math.max(1, Number(page) || 1); const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  const userRes = await query(`SELECT id FROM users WHERE steam_id=$1 LIMIT 1`, [String(steamId)]);
  const user = userRes.rows[0];
  if (!user) return { page: safePage, limit: safeLimit, total: 0, items: [] };
  const countRes = await query(`SELECT COUNT(*)::int AS total FROM match_players mp JOIN matches m ON m.id=mp.match_id WHERE mp.user_id=$1 AND m.status='finished'`, [user.id]);
  const rows = await query(
    `SELECT m.public_match_id, m.map_name, m.team_a_score, m.team_b_score, m.winner_team, m.finished_at, m.duration_seconds,
            mp.team, mp.result, mp.elo_before, mp.elo_after, mp.elo_delta, mp.kills, mp.deaths, mp.assists, mp.damage, mp.is_match_mvp
     FROM match_players mp JOIN matches m ON m.id=mp.match_id
     WHERE mp.user_id=$1 AND m.status='finished' ORDER BY m.finished_at DESC NULLS LAST, m.created_at DESC LIMIT $2 OFFSET $3`, [user.id, safeLimit, (safePage-1)*safeLimit]
  );
  return { page: safePage, limit: safeLimit, total: Number(countRes.rows[0]?.total || 0), items: rows.rows.map((r)=>({ matchId:r.public_match_id, mapName:r.map_name, score:{teamA:Number(r.team_a_score||0), teamB:Number(r.team_b_score||0), winnerTeam:r.winner_team}, finishedAt:r.finished_at, durationSeconds:r.duration_seconds==null?null:Number(r.duration_seconds), team:r.team, result:r.result, eloBefore:r.elo_before, eloAfter:r.elo_after, eloDelta:r.elo_delta, stats:{kills:Number(r.kills||0),deaths:Number(r.deaths||0),assists:Number(r.assists||0),damage:Number(r.damage||0)}, isMatchMvp:!!r.is_match_mvp })) };
}

async function getPlayerAggregatedStatsBySteamId(steamId) {
  const userRes = await query(`SELECT id, COALESCE(pp.elo_2v2,100) AS elo FROM users u LEFT JOIN player_profiles pp ON pp.user_id=u.id WHERE u.steam_id=$1 LIMIT 1`, [String(steamId)]);
  const user = userRes.rows[0];
  const zero = { steamId:String(steamId), matches:0, wins:0, losses:0, winrate:0, kills:0, deaths:0, assists:0, kd:0, averageDamagePerMatch:0, averageDamagePerRound:0, headshotRate:0, matchMvps:0, currentStreak:{type:null,count:0}, bestWinStreak:0, maps:{}, currentElo:user?Number(user.elo):100 };
  if (!user) return zero;
  const rows = await query(
    `SELECT m.id, m.map_name, mp.result, mp.kills, mp.deaths, mp.assists, mp.headshots, mp.damage, mp.is_match_mvp, COALESCE(COUNT(mr.id),0)::int AS rounds
     FROM match_players mp JOIN matches m ON m.id=mp.match_id LEFT JOIN match_rounds mr ON mr.match_id=m.id
     WHERE mp.user_id=$1 AND m.status='finished' GROUP BY m.id, mp.id ORDER BY COALESCE(m.finished_at,m.created_at) ASC`, [user.id]
  );
  if (!rows.rows.length) return zero;
  const stats = { ...zero, matches: rows.rows.length };
  let totalRounds = 0; const results=[];
  for (const r of rows.rows) {
    const win = r.result === 'win'; results.push(r.result); stats.wins += win ? 1 : 0; stats.losses += r.result === 'loss' ? 1 : 0;
    stats.kills += Number(r.kills||0); stats.deaths += Number(r.deaths||0); stats.assists += Number(r.assists||0);
    stats.headshotRate += Number(r.headshots||0); stats.averageDamagePerMatch += Number(r.damage||0); stats.matchMvps += r.is_match_mvp ? 1 : 0; totalRounds += Number(r.rounds||0);
    const key = r.map_name || 'unknown'; stats.maps[key] ||= { matches:0, wins:0, losses:0 }; stats.maps[key].matches += 1; stats.maps[key].wins += win ? 1 : 0; stats.maps[key].losses += r.result === 'loss' ? 1 : 0;
  }
  const headshots = stats.headshotRate; stats.winrate = stats.matches ? Math.round((stats.wins/stats.matches)*10000)/100 : 0; stats.kd = stats.deaths ? Math.round((stats.kills/stats.deaths)*100)/100 : stats.kills; stats.averageDamagePerRound = totalRounds ? Math.round((stats.averageDamagePerMatch/totalRounds)*100)/100 : 0; stats.averageDamagePerMatch = Math.round((stats.averageDamagePerMatch/stats.matches)*100)/100; stats.headshotRate = stats.kills ? Math.round((headshots/stats.kills)*10000)/100 : 0;
  const streaks = buildStreaks(results); stats.bestWinStreak = streaks.bestWinStreak; let cur=0; const last=results[results.length-1]; for(let i=results.length-1;i>=0&&results[i]===last;i--) cur++; stats.currentStreak={type:last,count:cur};
  for (const m of Object.values(stats.maps)) m.winrate = m.matches ? Math.round((m.wins/m.matches)*10000)/100 : 0;
  return stats;
}

module.exports = {
  getProfileSummaryByUserId,
  getProfileHistoryByUserId,
  getMatchDetailsForUser,
  getMatchDetails,
  getPlayerMatchHistoryBySteamId,
  getPlayerAggregatedStatsBySteamId
};
