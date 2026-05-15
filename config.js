const RANKS = [
  {
    "key": "recruit_iii",
    "name": "Recruit III",
    "tierName": "Recruit",
    "division": "III",
    "minElo": 0,
    "color": "recruit"
  },
  {
    "key": "recruit_ii",
    "name": "Recruit II",
    "tierName": "Recruit",
    "division": "II",
    "minElo": 100,
    "color": "recruit"
  },
  {
    "key": "recruit_i",
    "name": "Recruit I",
    "tierName": "Recruit",
    "division": "I",
    "minElo": 200,
    "color": "recruit"
  },
  {
    "key": "operative_iii",
    "name": "Operative III",
    "tierName": "Operative",
    "division": "III",
    "minElo": 300,
    "color": "operative"
  },
  {
    "key": "operative_ii",
    "name": "Operative II",
    "tierName": "Operative",
    "division": "II",
    "minElo": 400,
    "color": "operative"
  },
  {
    "key": "operative_i",
    "name": "Operative I",
    "tierName": "Operative",
    "division": "I",
    "minElo": 500,
    "color": "operative"
  },
  {
    "key": "vanguard_iii",
    "name": "Vanguard III",
    "tierName": "Vanguard",
    "division": "III",
    "minElo": 600,
    "color": "vanguard"
  },
  {
    "key": "vanguard_ii",
    "name": "Vanguard II",
    "tierName": "Vanguard",
    "division": "II",
    "minElo": 700,
    "color": "vanguard"
  },
  {
    "key": "vanguard_i",
    "name": "Vanguard I",
    "tierName": "Vanguard",
    "division": "I",
    "minElo": 800,
    "color": "vanguard"
  },
  {
    "key": "sentinel_iii",
    "name": "Sentinel III",
    "tierName": "Sentinel",
    "division": "III",
    "minElo": 900,
    "color": "sentinel"
  },
  {
    "key": "sentinel_ii",
    "name": "Sentinel II",
    "tierName": "Sentinel",
    "division": "II",
    "minElo": 1000,
    "color": "sentinel"
  },
  {
    "key": "sentinel_i",
    "name": "Sentinel I",
    "tierName": "Sentinel",
    "division": "I",
    "minElo": 1100,
    "color": "sentinel"
  },
  {
    "key": "phantom_iii",
    "name": "Phantom III",
    "tierName": "Phantom",
    "division": "III",
    "minElo": 1200,
    "color": "phantom"
  },
  {
    "key": "phantom_ii",
    "name": "Phantom II",
    "tierName": "Phantom",
    "division": "II",
    "minElo": 1300,
    "color": "phantom"
  },
  {
    "key": "phantom_i",
    "name": "Phantom I",
    "tierName": "Phantom",
    "division": "I",
    "minElo": 1400,
    "color": "phantom"
  },
  {
    "key": "ascendant_iii",
    "name": "Ascendant III",
    "tierName": "Ascendant",
    "division": "III",
    "minElo": 1500,
    "color": "ascendant"
  },
  {
    "key": "ascendant_ii",
    "name": "Ascendant II",
    "tierName": "Ascendant",
    "division": "II",
    "minElo": 1600,
    "color": "ascendant"
  },
  {
    "key": "ascendant_i",
    "name": "Ascendant I",
    "tierName": "Ascendant",
    "division": "I",
    "minElo": 1700,
    "color": "ascendant"
  },
  {
    "key": "dominion_iii",
    "name": "Dominion III",
    "tierName": "Dominion",
    "division": "III",
    "minElo": 1800,
    "color": "dominion"
  },
  {
    "key": "dominion_ii",
    "name": "Dominion II",
    "tierName": "Dominion",
    "division": "II",
    "minElo": 1900,
    "color": "dominion"
  },
  {
    "key": "dominion_i",
    "name": "Dominion I",
    "tierName": "Dominion",
    "division": "I",
    "minElo": 2000,
    "color": "dominion"
  },
  {
    "key": "sovereign_iii",
    "name": "Sovereign III",
    "tierName": "Sovereign",
    "division": "III",
    "minElo": 2100,
    "color": "sovereign"
  },
  {
    "key": "sovereign_ii",
    "name": "Sovereign II",
    "tierName": "Sovereign",
    "division": "II",
    "minElo": 2200,
    "color": "sovereign"
  },
  {
    "key": "sovereign_i",
    "name": "Sovereign I",
    "tierName": "Sovereign",
    "division": "I",
    "minElo": 2300,
    "color": "sovereign"
  },
  {
    "key": "apex",
    "name": "Apex",
    "tierName": "Apex",
    "division": null,
    "minElo": 2400,
    "color": "apex"
  },
  {
    "key": "trust_elite",
    "name": "Trust Elite",
    "tierName": "Trust Elite",
    "division": null,
    "minElo": 2600,
    "color": "trust-elite"
  }
];


function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
}

function getRankForElo(rawElo) {
  const elo = Math.max(0, Number(rawElo) || 0);
  let currentIndex = 0;

  for (let i = 0; i < RANKS.length; i += 1) {
    if (elo >= RANKS[i].minElo) currentIndex = i;
    else break;
  }

  const current = RANKS[currentIndex];
  const next = RANKS[currentIndex + 1] || null;
  const currentFloor = current.minElo;
  const nextFloor = next ? next.minElo : null;
  const progressPercent = nextFloor == null
    ? 100
    : clampPercent(((elo - currentFloor) / Math.max(1, nextFloor - currentFloor)) * 100);
  const rp = nextFloor == null ? 100 : clampPercent(progressPercent);

  return {
    key: current.key,
    name: current.name,
    tierName: current.tierName,
    division: current.division,
    color: current.color,
    minElo: current.minElo,
    currentElo: elo,
    rating: elo,
    rp,
    nextRankKey: next?.key || null,
    nextRankName: next?.name || null,
    nextRankElo: next?.minElo || null,
    pointsToNext: next ? Math.max(0, next.minElo - elo) : 0,
    progressPercent,
    isMaxRank: !next
  };
}

module.exports = {
  RANKS,
  getRankForElo
};
