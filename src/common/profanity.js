/**
 * Profanity Filter
 *
 * Wraps `obscenity` to provide a single boolean check used by user-supplied
 * fields that surface to other players (display name today, future social
 * fields). The dataset is built once at module load — Lambda warm starts
 * keep the matcher in memory.
 */

const {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} = require('obscenity');

const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

function containsProfanity(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return matcher.hasMatch(text);
}

module.exports = { containsProfanity };
