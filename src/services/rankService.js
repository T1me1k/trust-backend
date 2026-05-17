const RANKS = [
  {
    "key": "iron",
    "name": "Iron",
    "tierName": "Iron",
    "division": null,
    "minElo": 0,
    "color": "iron",
    "icon": "iron.svg"
  },
  {
    "key": "bronze",
    "name": "Bronze",
    "tierName": "Bronze",
    "division": null,
    "minElo": 225,
    "color": "bronze",
    "icon": "bronze.svg"
  },
  {
    "key": "silver",
    "name": "Silver",
    "tierName": "Silver",
    "division": null,
    "minElo": 450,
    "color": "silver",
    "icon": "silver.svg"
  },
  {
    "key": "gold",
    "name": "Gold",
    "tierName": "Gold",
    "division": null,
    "minElo": 675,
    "color": "gold",
    "icon": "gold.svg"
  },
  {
    "key": "platinum",
    "name": "Platinum",
    "tierName": "Platinum",
    "division": null,
    "minElo": 900,
    "color": "platinum",
    "icon": "platinum.svg"
  },
  {
    "key": "diamond",
    "name": "Diamond",
    "tierName": "Diamond",
    "division": null,
    "minElo": 1125,
    "color": "diamond",
    "icon": "diamond.svg"
  },
  {
    "key": "master",
    "name": "Master",
    "tierName": "Master",
    "division": null,
    "minElo": 1350,
    "color": "master",
    "icon": "master.svg"
  },
  {
    "key": "grandmaster",
    "name": "Grandmaster",
    "tierName": "Grandmaster",
    "division": null,
    "minElo": 1575,
    "color": "grandmaster",
    "icon": "grandmaster.svg"
  },
  {
    "key": "elite",
    "name": "Elite",
    "tierName": "Elite",
    "division": null,
    "minElo": 1800,
    "color": "elite",
    "icon": "elite.svg"
  },
  {
    "key": "legend",
    "name": "Legend",
    "tierName": "Legend",
    "division": null,
    "minElo": 2000,
    "color": "legend",
    "icon": "legend.svg"
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
    icon: current.icon,
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
