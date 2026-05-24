// Daily Quests — pure helpers (theme math, slot selection, progress matching, skip-fast).
// Persistence + endpoint wiring live in sibling tasks. No DynamoDB calls here.

let catalogCache = null;
function loadCatalog() {
  if (catalogCache) return catalogCache;
  try {
    catalogCache = require('../data/daily-quests.json');
  }
  catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      catalogCache = { version: '0.0.0', quests: [] };
    }
    else {
      throw e;
    }
  }
  return catalogCache;
}

const AFFINITIES = ['strength', 'agility', 'wisdom'];
const DOMAINS = ['air', 'earth', 'water'];
const DAILY_ACTIONS = ['feed', 'train', 'treat'];

function computeDayOfYear(date) {
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const cur = Date.UTC(year, date.getUTCMonth(), date.getUTCDate());
  return Math.floor((cur - start) / 86400000) + 1;
}

function getTodayUTCDateString(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function getNextUTCMidnight(date) {
  const d = new Date(date);
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

// Theme cycles through 3 affinities, 3 domains, 3 actions on dayOfYear.
// All three use (dayOfYear+1)%3 so 2026-05-16 (day 136) yields wisdom/water/treat
// to match the example table in docs/daily-quests-plan.md (lines 52-62). The plan's
// original formula (mod 3 for affinity/action, mod 3 with +1 only on domain) does
// NOT match its own example table — fixed here, plan doc should be updated.
function getDailyTheme(date) {
  const d = computeDayOfYear(date);
  const idx = (d + 1) % 3;
  return {
    affinity: AFFINITIES[idx],
    domain: DOMAINS[idx],
    action: DAILY_ACTIONS[idx],
  };
}

function getPlayerCapabilities(user) {
  const stats = (user && user.stats) || {};
  // These fields aren't all populated on existing user records today.
  // Default permissively; the persistence/handler layer should compute
  // highestStage from the totems table (see get-public-profile.js:59-74)
  // and pass an enriched user.stats in.
  return {
    maxStage: stats.highestStage != null ? stats.highestStage : 4,
    hasStage4Totem: stats.highestStage != null ? stats.highestStage >= 4 : true,
    hasSanctumSeat: !!stats.sanctumSeats && stats.sanctumSeats > 0,
    openExpeditions: stats.openExpeditions != null ? stats.openExpeditions : 1,
    totalTotems: stats.totalTotems || 0,
  };
}

function questPassesCaps(quest, caps) {
  const req = quest.requires || {};
  if (req.hasStage4Totem && !caps.hasStage4Totem) return false;
  if (req.hasSanctumSeat && !caps.hasSanctumSeat) return false;
  if (req.minStage != null && caps.maxStage < req.minStage) return false;
  return true;
}

function pickOne(candidates, rng) {
  if (candidates.length === 0) return null;
  const i = Math.floor(rng() * candidates.length);
  return candidates[i];
}

function toRuntimeQuest(slot, def) {
  const quest = {
    slot,
    id: def.id,
    name: def.name,
    description: def.description,
    tier: def.tier,
    goal: def.goal,
    progress: 0,
    claimed: false,
    reward: def.reward,
    completed: false,
  };
  if (def.filters && def.filters.uniqueTotems) {
    quest.seenTotems = [];
  }
  return quest;
}

function generateDailyQuestSet({ theme, playerCaps, yesterdayIds = [], rng = Math.random } = {}) {
  const { quests: catalog } = loadCatalog();
  const exclude = new Set(yesterdayIds);
  const caps = playerCaps || getPlayerCapabilities({});

  // Slot 1: themed action — exactly 1 deterministic match.
  const slot1 = catalog.find(q =>
    q.slotEligibility.includes('themed_action') &&
    q.themeTags && q.themeTags.action === theme.action,
  );

  // Slot 2: free easy, excluding slot1 + yesterday.
  const slot2Candidates = catalog.filter(q =>
    q.slotEligibility.includes('free_easy') &&
    (!slot1 || q.id !== slot1.id) &&
    !exclude.has(q.id),
  );
  const slot2 = pickOne(slot2Candidates, rng) ||
    pickOne(catalog.filter(q => q.slotEligibility.includes('free_easy')), rng);

  // Slot 3: affinity-challenge — exactly 1 deterministic match.
  const slot3 = catalog.find(q =>
    q.slotEligibility.includes('affinity') &&
    q.themeTags && q.themeTags.affinity === theme.affinity,
  );

  // Slot 4: domain-expedition matching theme (start vs claim is the rng pick).
  const slot4Candidates = catalog.filter(q =>
    q.slotEligibility.includes('domain_expedition') &&
    q.themeTags && q.themeTags.domain === theme.domain &&
    questPassesCaps(q, caps),
  );
  const slot4 = pickOne(slot4Candidates, rng);

  // Slot 5: hard objective, caps-safe, excluding yesterday.
  let slot5Candidates = catalog.filter(q =>
    q.slotEligibility.includes('hard') &&
    !exclude.has(q.id) &&
    questPassesCaps(q, caps),
  );
  if (slot5Candidates.length === 0) {
    slot5Candidates = catalog.filter(q =>
      q.slotEligibility.includes('hard') && questPassesCaps(q, caps),
    );
  }
  const slot5 = pickOne(slot5Candidates, rng);

  return [
    slot1 && toRuntimeQuest(1, slot1),
    slot2 && toRuntimeQuest(2, slot2),
    slot3 && toRuntimeQuest(3, slot3),
    slot4 && toRuntimeQuest(4, slot4),
    slot5 && toRuntimeQuest(5, slot5),
  ].filter(Boolean);
}

function questMatches(quest, trigger, data) {
  const { quests: catalog } = loadCatalog();
  const def = catalog.find(q => q.id === quest.id);
  if (!def || def.trigger !== trigger) return false;
  const filters = def.filters || {};
  for (const key of Object.keys(filters)) {
    if (key === 'uniqueTotems') {
      const totemId = (data || {}).totemId;
      if (!totemId) return false;
      const seen = quest.seenTotems || [];
      if (seen.includes(totemId)) return false;
      continue;
    }
    if ((data || {})[key] !== filters[key]) return false;
  }
  return true;
}

function shouldSkipQuestProgress(user, todayUTC) {
  if (!user || !todayUTC) return true;
  return user.lastQuestDate !== todayUTC;
}

// --- Persistence layer ---------------------------------------------------

const { TABLES, userPK, getItem, putItem, rawUpdate, updateUser, addEssence, addRunes, getUserTotems, getUser } = require('../common/db-client');
const { onQuestSetClaimed, onQuestThemedClaimed } = require('./achievements-service');

// Bonus rune drop: 80% Lesser, 18% Greater, 2% Ancient.
// Injectable rng for tests.
function rollBonusRune(rng = Math.random) {
  const r = rng();
  if (r < 0.80) return { lesser: 1 };
  if (r < 0.98) return { greater: 1 };
  return { ancient: 1 };
}

const TTL_SECONDS = 48 * 3600;

function questSK(date) {
  return `QUEST#daily#${date}`;
}

function yesterdayUTC(today) {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function recomputeBonusUnlocked(quests) {
  return quests.length === 5 && quests.every(q => q.claimed);
}

async function getQuestRecord(userId, date) {
  return getItem(TABLES.REWARD_STATE, { pk: userPK(userId), sk: questSK(date) });
}

async function getYesterdayQuestIds(userId, today) {
  const record = await getQuestRecord(userId, yesterdayUTC(today));
  if (!record || !Array.isArray(record.quests)) return [];
  return record.quests.map(q => q.id);
}

async function deriveLivePlayerCaps(userId, user) {
  const totems = await getUserTotems(userId).catch(() => []);
  const maxStage = totems.reduce((m, t) => Math.max(m, t.stage || 0), 0);
  const stats = (user && user.stats) || {};
  return {
    maxStage,
    hasStage4Totem: maxStage >= 4,
    hasSanctumSeat: !!stats.sanctumSeats && stats.sanctumSeats > 0,
    openExpeditions: stats.openExpeditions != null ? stats.openExpeditions : 1,
    totalTotems: totems.length,
  };
}

async function generateAndPersist(userId, user, now = new Date()) {
  const date = getTodayUTCDateString(now);
  const theme = getDailyTheme(now);
  const [yesterdayIds, caps] = await Promise.all([
    getYesterdayQuestIds(userId, date),
    deriveLivePlayerCaps(userId, user),
  ]);
  const quests = generateDailyQuestSet({ theme, playerCaps: caps, yesterdayIds });

  const item = {
    pk: userPK(userId),
    sk: questSK(date),
    date,
    generatedAt: now.toISOString(),
    theme,
    quests,
    bonus: { reward: { essence: 75 }, claimed: false },
    ttl: Math.floor(now.getTime() / 1000) + TTL_SECONDS,
  };

  await putItem(TABLES.REWARD_STATE, item);
  await updateUser(userId, { lastQuestDate: date });
  return item;
}

async function getOrCreateTodayQuests(userId, user, now = new Date()) {
  const date = getTodayUTCDateString(now);
  const existing = await getQuestRecord(userId, date);
  if (existing) return existing;
  return generateAndPersist(userId, user, now);
}

async function applyProgressUpdate(userId, date, updates) {
  if (!updates.length) return;
  const names = { '#quests': 'quests', '#progress': 'progress', '#date': 'date' };
  const values = { ':today': date };
  const sets = [];
  updates.forEach((u, i) => {
    const v = `:p${i}`;
    values[v] = u.newProgress;
    sets.push(`#quests[${u.slot - 1}].#progress = ${v}`);
    if (u.newSeenTotems) {
      names['#seenTotems'] = 'seenTotems';
      const s = `:s${i}`;
      values[s] = u.newSeenTotems;
      sets.push(`#quests[${u.slot - 1}].#seenTotems = ${s}`);
    }
  });
  try {
    await rawUpdate(TABLES.REWARD_STATE, { pk: userPK(userId), sk: questSK(date) }, {
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: '#date = :today',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    });
  }
  catch (err) {
    if (err.name !== 'ConditionalCheckFailedException') throw err;
  }
}

async function onQuestProgress(userId, user, trigger, data, now = new Date()) {
  const today = getTodayUTCDateString(now);
  if (shouldSkipQuestProgress(user, today)) return [];

  const record = await getQuestRecord(userId, today);
  if (!record || !Array.isArray(record.quests)) return [];

  const { quests: catalog } = loadCatalog();
  const updates = [];
  for (const quest of record.quests) {
    if (quest.claimed) continue;
    if (quest.progress >= quest.goal) continue;
    if (!questMatches(quest, trigger, data)) continue;
    const update = { slot: quest.slot, newProgress: Math.min(quest.progress + 1, quest.goal) };
    const def = catalog.find(q => q.id === quest.id);
    if (def && def.filters && def.filters.uniqueTotems && data && data.totemId) {
      update.newSeenTotems = [...(quest.seenTotems || []), data.totemId];
    }
    updates.push(update);
  }
  if (!updates.length) return [];

  await applyProgressUpdate(userId, today, updates);
  return updates;
}

// Convenience wrapper for action handlers — loads the user if caller doesn't have one.
// Swallows errors so quest progress can never fail an action handler. Returns [] on any issue.
async function emitQuestProgress(userId, trigger, data, options = {}) {
  try {
    if (!userId) return [];
    const user = options.user || await getUser(userId);
    return await onQuestProgress(userId, user, trigger, data, options.now || new Date());
  }
  catch (err) {
    console.error('[emitQuestProgress] swallowed error:', err);
    return [];
  }
}

async function batchClaim(userId, date, now = new Date()) {
  const record = await getQuestRecord(userId, date);
  if (!record) return { claimed: [], bonusClaimed: false, totalEssenceAwarded: 0 };

  const claimable = record.quests
    .map((q, i) => ({ ...q, _idx: i }))
    .filter(q => !q.claimed && q.progress >= q.goal);

  const bonusUnlockable = !record.bonus.claimed &&
    record.quests.every((q, i) => q.claimed || claimable.some(c => c._idx === i));

  if (!claimable.length && !bonusUnlockable) {
    return { claimed: [], bonusClaimed: false, totalEssenceAwarded: 0 };
  }

  const names = { '#quests': 'quests', '#claimed': 'claimed', '#claimedAt': 'claimedAt', '#date': 'date' };
  const values = { ':true': true, ':now': now.toISOString(), ':today': date };
  const sets = [];
  const conditions = ['#date = :today'];

  claimable.forEach((q, i) => {
    const cKey = `:cf${i}`;
    values[cKey] = false;
    sets.push(`#quests[${q._idx}].#claimed = :true`);
    sets.push(`#quests[${q._idx}].#claimedAt = :now`);
    conditions.push(`#quests[${q._idx}].#claimed = ${cKey}`);
  });

  let bonusClaimed = false;
  if (bonusUnlockable) {
    names['#bonus'] = 'bonus';
    values[':false'] = false;
    sets.push('#bonus.#claimed = :true');
    sets.push('#bonus.#claimedAt = :now');
    conditions.push('#bonus.#claimed = :false');
    bonusClaimed = true;
  }

  try {
    await rawUpdate(TABLES.REWARD_STATE, { pk: userPK(userId), sk: questSK(date) }, {
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: conditions.join(' AND '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    });
  }
  catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return { claimed: [], bonusClaimed: false, totalEssenceAwarded: 0 };
    }
    throw err;
  }

  const claimedEntries = claimable.map(q => ({ questId: q.id, reward: q.reward }));
  let total = claimedEntries.reduce((s, e) => s + (e.reward.essence || 0), 0);
  if (bonusClaimed) total += record.bonus.reward.essence || 0;

  let newBalance = null;
  if (total > 0) {
    const credit = await addEssence(userId, total, { type: 'reward_quest', ref: questSK(date) });
    newBalance = credit && credit.newBalance != null ? credit.newBalance : null;
  }

  // Bonus rune drop — only fires when the bonus is claimed in this batch.
  let runesAwarded = null;
  if (bonusClaimed) {
    try {
      runesAwarded = rollBonusRune();
      await addRunes(userId, runesAwarded, { type: 'reward_quest_bonus', ref: questSK(date) });
    }
    catch (err) {
      console.error('[batchClaim] rune drop failed:', err);
      runesAwarded = null;
    }
  }

  // Achievement progress — runs after Essence credit, swallows errors so claim is not blocked.
  const achievements = [];
  try {
    const themedClaimed = claimable.filter(q => q.slot === 3 || q.slot === 4).length;
    if (themedClaimed > 0 || bonusClaimed) {
      const fresh = await getUser(userId);
      const stats = (fresh && fresh.stats) || {};
      const prevSetCount = stats.totalQuestSetsCompleted || 0;
      const prevThemedCount = stats.totalThemedQuestClaims || 0;
      const nextSetCount = prevSetCount + (bonusClaimed ? 1 : 0);
      const nextThemedCount = prevThemedCount + themedClaimed;

      const userUpdates = {};
      if (themedClaimed > 0) userUpdates['stats.totalThemedQuestClaims'] = nextThemedCount;
      if (bonusClaimed) userUpdates['stats.totalQuestSetsCompleted'] = nextSetCount;
      if (Object.keys(userUpdates).length) await updateUser(userId, userUpdates);

      if (themedClaimed > 0) {
        const r = await onQuestThemedClaimed(userId, { totalThemedClaimCount: nextThemedCount });
        for (const a of (r || [])) if (a.unlocked) achievements.push(a);
      }
      if (bonusClaimed) {
        const r = await onQuestSetClaimed(userId, { totalQuestSetCount: nextSetCount });
        for (const a of (r || [])) if (a.unlocked) achievements.push(a);
      }
    }
  }
  catch (err) {
    console.error('[batchClaim] achievement check failed:', err);
  }

  return { claimed: claimedEntries, bonusClaimed, totalEssenceAwarded: total, newBalance, achievements, runesAwarded };
}

module.exports = {
  AFFINITIES,
  DOMAINS,
  DAILY_ACTIONS,
  TTL_SECONDS,
  computeDayOfYear,
  getTodayUTCDateString,
  getNextUTCMidnight,
  getDailyTheme,
  getPlayerCapabilities,
  generateDailyQuestSet,
  questMatches,
  shouldSkipQuestProgress,
  // Persistence
  questSK,
  yesterdayUTC,
  recomputeBonusUnlocked,
  getQuestRecord,
  getYesterdayQuestIds,
  deriveLivePlayerCaps,
  generateAndPersist,
  getOrCreateTodayQuests,
  applyProgressUpdate,
  onQuestProgress,
  emitQuestProgress,
  batchClaim,
  _resetCatalogCacheForTests: () => {
    catalogCache = null; 
  },
};
