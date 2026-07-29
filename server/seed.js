import { state } from './store.js';

/**
 * Nothing is seeded.
 *
 * Every coin on this exchange is issued by a player, and every trade is between
 * real people, so there are no house coins and no NPC traders to fake activity.
 * A brand new exchange is genuinely empty until somebody creates the first coin.
 */
export function seed() {
  state.meta.seededAt = Date.now();
  console.log('[seed] empty exchange — players create every coin from the Create Coin page');
}
