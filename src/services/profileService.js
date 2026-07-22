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


function round2(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100) / 100;
}

function toIso(value) { return value ? new Date(value).toISOString() : null; }
function validSteamId(steamId) { return /^[0-9]{17}$/.test(String(steamId || '')); }
function normalizeResult(status, winnerTeam, team) {
  if (status !== 'finished') return 'pending';
  if (!winnerTeam) return 'draw';
  if (!team) return 'pending';
  return winnerTeam === team ? 'win' : 'loss';
}
function reasonLabel(reason) {
  const labels = { 7: 'elimination', 8: 'bomb_defused', 9: 'bomb_exploded', 12: 'time_expired' };
  return labels[String(reason)] || (reason == null ? null : String(reason));
}

function flatStats(row) {
  if (!row.has_detailed_stats) {
    return { kills:null, deaths:null, assists:null, headshots:null, damage:null, mvps:null, firstKills:null, clutches:null };
  }
  return {
    kills:Number(row.kills || 0), deaths:Number(row.deaths || 0), assists:Number(row.assists || 0),
    headshots:Number(row.headshots || 0), damage:Number(row.damage || 0), mvps:Number(row.mvps || 0),
    firstKills:Number(row.first_kills || 0), clutches:Number(row.clutches || 0)
  };
}

async function getMatchDetails(publicMatchId) {
  if (!publicMatchId || String(publicMatchId).length > 128) return null;
  const matchRes = await query(
    `SELECT m.id, m.public_match_id, m.mode, m.status, m.map_name, m.team_a_score, m.team_b_score, m.winner_team,
            m.started_at, m.finished_at, m.created_at, m.duration_seconds, si.name AS server_name, si.region AS server_region
     FROM matches m LEFT JOIN server_instances si ON si.id::text = m.server_id
     WHERE m.public_match_id = $1 LIMIT 1`, [String(publicMatchId)]
  );
  const match = matchRes.rows[0] || null;
  if (!match) return null;
  const playersRes = await query(
    `SELECT mp.user_id, mp.team, mp.slot_index, mp.elo_before, mp.elo_after, mp.elo_delta, mp.result,
            mp.kills, mp.deaths, mp.assists, mp.headshots, mp.damage, mp.mvps, mp.first_kills, mp.clutches,
            mp.is_match_mvp, mp.has_detailed_stats, u.steam_id, u.persona_name, u.avatar_full_url, COALESCE(pp.elo_2v2,100) AS elo_2v2
     FROM match_players mp JOIN users u ON u.id=mp.user_id LEFT JOIN player_profiles pp ON pp.user_id=mp.user_id
     WHERE mp.match_id=$1 ORDER BY mp.team ASC, mp.slot_index ASC, u.steam_id ASC`, [match.id]
  );
  const roundsRes = await query(
    `SELECT round_number, winner_team, reason, team_a_score, team_b_score, duration_seconds FROM match_rounds WHERE match_id=$1 ORDER BY round_number ASC`, [match.id]
  );
  const players = playersRes.rows.map((row) => {
    const stats = flatStats(row);
    return {
      userId: row.user_id, steamId: row.steam_id, nickname: row.persona_name, avatarUrl: row.avatar_full_url || null,
      team: row.team, slotIndex: Number(row.slot_index || 0), ...stats,
      eloBefore: row.elo_before == null ? null : Number(row.elo_before), eloAfter: row.elo_after == null ? null : Number(row.elo_after),
      eloChange: row.elo_delta == null ? null : Number(row.elo_delta), eloDelta: row.elo_delta == null ? null : Number(row.elo_delta),
      result: row.result || null, isMatchMvp: !!row.is_match_mvp, hasDetailedStats: !!row.has_detailed_stats,
      rank: getRankForElo(Number(row.elo_after || row.elo_2v2 || 100))
    };
  });
  return {
    id: match.public_match_id, matchId: match.public_match_id, publicMatchId: match.public_match_id, mode: match.mode,
    status: match.status === 'finished' ? 'completed' : match.status, rawStatus: match.status,
    map: match.map_name || null, mapName: match.map_name || null, winnerTeam: match.winner_team || null,
    teamAScore: Number(match.team_a_score || 0), teamBScore: Number(match.team_b_score || 0),
    startedAt: toIso(match.started_at), completedAt: toIso(match.finished_at), finishedAt: toIso(match.finished_at), createdAt: toIso(match.created_at),
    durationSeconds: match.duration_seconds == null ? null : Number(match.duration_seconds),
    server: { name: match.server_name || null, region: match.server_region || null },
    players,
    teams: { A: players.filter((p)=>p.team==='A'), B: players.filter((p)=>p.team==='B') },
    rounds: roundsRes.rows.map((r)=>({ roundNumber:Number(r.round_number), winnerTeam:r.winner_team, reason:r.reason, reasonLabel:reasonLabel(r.reason), teamAScore:Number(r.team_a_score||0), teamBScore:Number(r.team_b_score||0), durationSeconds:r.duration_seconds==null?null:Number(r.duration_seconds) }))
  };
}

async function getPlayerMatchHistoryBySteamId(steamId, page = 1, limit = 20) {
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1); const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 20, 50));
  if (!validSteamId(steamId)) return { items: [], page: safePage, limit: safeLimit, total: 0, totalPages: 0 };
  const userRes = await query(`SELECT id FROM users WHERE steam_id=$1 LIMIT 1`, [String(steamId)]);
  const user = userRes.rows[0];
  if (!user) return { items: [], page: safePage, limit: safeLimit, total: 0, totalPages: 0 };
  const countRes = await query(`SELECT COUNT(*)::int AS total FROM match_players mp JOIN matches m ON m.id=mp.match_id WHERE mp.user_id=$1`, [user.id]);
  const total = Number(countRes.rows[0]?.total || 0);
  const rows = await query(
    `SELECT m.public_match_id, m.status, m.map_name, m.team_a_score, m.team_b_score, m.winner_team, COALESCE(m.finished_at,m.started_at,m.created_at) AS played_at,
            mp.team, mp.result, mp.elo_delta, mp.kills, mp.deaths, mp.assists, mp.is_match_mvp, mp.has_detailed_stats
     FROM match_players mp JOIN matches m ON m.id=mp.match_id
     WHERE mp.user_id=$1 ORDER BY COALESCE(m.finished_at,m.started_at,m.created_at) DESC LIMIT $2 OFFSET $3`, [user.id, safeLimit, (safePage-1)*safeLimit]
  );
  return { items: rows.rows.map((r)=>{ const result=normalizeResult(r.status,r.winner_team,r.team); const teamScore=r.team==='A'?Number(r.team_a_score||0):Number(r.team_b_score||0); const opponentScore=r.team==='A'?Number(r.team_b_score||0):Number(r.team_a_score||0); return { id:r.public_match_id, matchId:r.public_match_id, status:r.status==='finished'?'completed':r.status, map:r.map_name, mapName:r.map_name, playedAt:toIso(r.played_at), team:r.team, winnerTeam:r.winner_team, result, teamScore, opponentScore, kills:r.has_detailed_stats?Number(r.kills||0):null, deaths:r.has_detailed_stats?Number(r.deaths||0):null, assists:r.has_detailed_stats?Number(r.assists||0):null, eloChange:r.elo_delta==null?null:Number(r.elo_delta), isMatchMvp:!!r.is_match_mvp, hasDetailedStats:!!r.has_detailed_stats }; }), page:safePage, limit:safeLimit, total, totalPages: Math.ceil(total / safeLimit) };
}

async function getPlayerAggregatedStatsBySteamId(steamId) {
  const zero = { matches:0, wins:0, losses:0, draws:0, winrate:0, kills:0, deaths:0, assists:0, kd:0, headshots:0, headshotRate:0, damage:0, averageDamagePerMatch:0, averageDamagePerRound:0, matchMvpCount:0, currentStreak:{type:'none',count:0}, bestWinStreak:0, maps:[] };
  if (!validSteamId(steamId)) return zero;
  const userRes = await query(`SELECT id FROM users WHERE steam_id=$1 LIMIT 1`, [String(steamId)]);
  const user = userRes.rows[0]; if (!user) return zero;
  const rows = await query(
    `SELECT m.id, m.map_name, m.winner_team, m.team_a_score, m.team_b_score, COALESCE(m.finished_at,m.created_at) AS played_at,
            mp.team, mp.kills, mp.deaths, mp.assists, mp.headshots, mp.damage, mp.is_match_mvp, mp.has_detailed_stats, COALESCE(COUNT(mr.id),0)::int AS rounds
     FROM match_players mp JOIN matches m ON m.id=mp.match_id LEFT JOIN match_rounds mr ON mr.match_id=m.id
     WHERE mp.user_id=$1 AND m.status='finished' GROUP BY m.id, mp.id ORDER BY COALESCE(m.finished_at,m.created_at) DESC`, [user.id]
  );
  if (!rows.rows.length) return zero;
  const out = { ...zero, matches: rows.rows.length, maps: [] }; const maps = new Map(); const results=[]; let telemetryMatches=0,totalRounds=0;
  for (const r of rows.rows) { const result=normalizeResult('finished',r.winner_team,r.team); results.push(result); out.wins += result==='win'?1:0; out.losses += result==='loss'?1:0; out.draws += result==='draw'?1:0; const key=r.map_name||'unknown'; if(!maps.has(key)) maps.set(key,{map:key,matches:0,wins:0,losses:0,kills:0,deaths:0,damage:0,telemetryMatches:0}); const m=maps.get(key); m.matches++; m.wins += result==='win'?1:0; m.losses += result==='loss'?1:0; if(r.has_detailed_stats){ telemetryMatches++; const kills=Number(r.kills||0), deaths=Number(r.deaths||0), assists=Number(r.assists||0), hs=Number(r.headshots||0), dmg=Number(r.damage||0); out.kills+=kills; out.deaths+=deaths; out.assists+=assists; out.headshots+=hs; out.damage+=dmg; out.matchMvpCount += r.is_match_mvp?1:0; totalRounds += Number(r.rounds||0); m.kills+=kills; m.deaths+=deaths; m.damage+=dmg; m.telemetryMatches++; } }
  out.winrate=round2(out.matches?out.wins/out.matches*100:0); out.kd=round2(out.deaths?out.kills/out.deaths:out.kills); out.headshotRate=round2(out.kills?out.headshots/out.kills*100:0); out.averageDamagePerMatch=round2(telemetryMatches?out.damage/telemetryMatches:0); out.averageDamagePerRound=round2(totalRounds?out.damage/totalRounds:0);
  const first=results[0]; if(first){ let c=0; for(const r of results){ if(r===first)c++; else break; } out.currentStreak={type:first,count:c}; }
  let run=0; for(const r of [...results].reverse()){ if(r==='win'){run++; out.bestWinStreak=Math.max(out.bestWinStreak,run);} else run=0; }
  out.maps=[...maps.values()].map((m)=>({ map:m.map, matches:m.matches, wins:m.wins, losses:m.losses, winrate:round2(m.matches?m.wins/m.matches*100:0), kills:m.kills, deaths:m.deaths, kd:round2(m.deaths?m.kills/m.deaths:m.kills), averageDamage:round2(m.telemetryMatches?m.damage/m.telemetryMatches:0) })).sort((a,b)=>b.matches-a.matches||a.map.localeCompare(b.map));
  return out;
}

module.exports = {
  getProfileSummaryByUserId,
  getProfileHistoryByUserId,
  getMatchDetailsForUser,
  getMatchDetails,
  getPlayerMatchHistoryBySteamId,
  getPlayerAggregatedStatsBySteamId
};
