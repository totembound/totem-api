/**
 * Totem XP — single chokepoint for adding experience to a totem.
 *
 * Every code path that grants a totem XP (train, expedition, sanctum
 * mission, future quests, etc.) MUST go through addTotemXp so prestige
 * threshold crossings are detected and the prestige-progression
 * achievement fires consistently.
 *
 * Achievement-reward XP (achievements-service.distributeAchievementReward)
 * intentionally does NOT route through here — that path can recurse
 * (prestige unlock grants XP → could push another threshold), so it uses
 * direct updateTotem and accepts the rare missed unlock until the next
 * legitimate XP gain catches it up.
 */

const { updateTotem } = require('../common/db-client');
const { calculatePrestigeLevel } = require('../functions/game-actions/helpers');

/**
 * Add XP to a totem and detect prestige threshold crossings.
 *
 * Awaits the prestige-achievement check so callers can merge the unlocked
 * achievement(s) into their action response — that is what makes the
 * frontend toast fire and the Achievements page patch live without a
 * refresh. Errors in the achievement check are swallowed (logged) so
 * they never break a successful XP update.
 *
 * @param {string} userId
 * @param {object} totem - The totem record. Must have `id` and `experience`.
 * @param {number} xpDelta - XP to add (>= 0).
 * @param {object} [opts]
 * @param {object} [opts.extraUpdates] - Additional totem fields to write
 *   atomically with the XP update (e.g. happiness, cooldowns, lastActionDates).
 * @returns {Promise<{
 *   newExperience: number,
 *   oldPrestige: number,
 *   newPrestige: number,
 *   prestigeIncreased: boolean,
 *   achievements: Array<{ achievementId, milestone, rewards }>
 * }>}
 */
async function addTotemXp(userId, totem, xpDelta, opts = {}) {
  if (!totem || !totem.id) {
    throw new Error('addTotemXp requires a totem object with id');
  }
  const delta = Number.isFinite(xpDelta) ? xpDelta : 0;
  const oldXp = totem.experience || 0;
  const newXp = oldXp + delta;
  const oldPrestige = calculatePrestigeLevel(oldXp);
  const newPrestige = calculatePrestigeLevel(newXp);
  const prestigeIncreased = newPrestige > oldPrestige;

  await updateTotem(userId, totem.id, {
    experience: newXp,
    ...(opts.extraUpdates || {}),
  });

  let achievements = [];
  if (prestigeIncreased) {
    // Lazy require to keep boundaries clean (and avoid circular import risk
    // if achievements-service ever needs totem-xp in the reward path).
    const { onTotemPrestiged } = require('./achievements-service');
    try {
      const results = await onTotemPrestiged(userId, {
        totemId: totem.id,
        oldPrestige,
        newPrestige,
      });
      achievements = (results || [])
        .filter(r => r && r.unlocked)
        .map(r => ({
          achievementId: r.achievementId,
          milestone: r.milestone,
          rewards: r.rewards,
        }));
    } catch (err) {
      console.error('[Prestige] Achievement check failed:', err?.message || err);
    }
  }

  return {
    newExperience: newXp,
    oldPrestige,
    newPrestige,
    prestigeIncreased,
    achievements,
  };
}

module.exports = { addTotemXp };
