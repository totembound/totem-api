/**
 * Totem Availability Utilities
 *
 * Shared busy-check helpers used by game actions, expeditions, forge, and sanctum.
 * Centralizes the logic for determining if a totem can perform various activities.
 */

/**
 * Check if a totem is available for game actions (Feed, Train, Treat).
 * Seated totems CAN perform actions (they're resting at the sanctum).
 * Totems on a Council Mission CANNOT (they're away).
 *
 * @param {object} totem - Totem record from DynamoDB
 * @returns {{ available: boolean, error?: { code: string, message: string } }}
 */
function checkActionAvailability(totem) {
  if (totem.sanctum?.onMission) {
    return {
      available: false,
      error: { code: 'ON_COUNCIL_MISSION', message: 'Totem is away on a Council Mission' },
    };
  }
  return { available: true };
}

/**
 * Check if a totem is available for expeditions or forge.
 * Seated totems CANNOT go on expeditions or be forged (they're locked).
 * Totems on active expeditions also CANNOT.
 *
 * @param {object} totem - Totem record from DynamoDB
 * @returns {{ available: boolean, error?: { code: string, message: string } }}
 */
function checkExpeditionAvailability(totem) {
  if (totem.sanctum?.seated) {
    return {
      available: false,
      error: { code: 'ON_COUNCIL', message: 'Totem is seated on the Elder Council' },
    };
  }
  return { available: true };
}

module.exports = {
  checkActionAvailability,
  checkExpeditionAvailability,
};
