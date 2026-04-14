const RANKS = [
  { key: 'iron', name: 'Iron', minElo: 0, color: 'iron' },
  { key: 'bronze', name: 'Bronze', minElo: 300, color: 'bronze' },
  { key: 'silver', name: 'Silver', minElo: 500, color: 'silver' },
  { key: 'gold_nova', name: 'Gold Nova', minElo: 700, color: 'gold' },
  { key: 'master_guardian', name: 'Master Guardian', minElo: 900, color: 'guardian' },
  { key: 'distinguished', name: 'Distinguished', minElo: 1100, color: 'distinguished' },
  { key: 'legendary_eagle', name: 'Legendary Eagle', minElo: 1300, color: 'eagle' },
  { key: 'supreme', name: 'Supreme', minElo: 1500, color: 'supreme' },
  { key: 'global_elite', name: 'Global Elite', minElo: 1700, color: 'global' }
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

  return {
    key: current.key,
    name: current.name,
    color: current.color,
    minElo: current.minElo,
    currentElo: elo,
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
