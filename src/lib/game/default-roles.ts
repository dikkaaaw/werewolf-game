import { SETTINGS } from './settings';
import type { RoleConfigEntry } from './types';

/**
 * Generate a standard, balanced role distribution for a given player count.
 *
 * Rules (unchanged by the move to a 5-player minimum; the 5-player row below is
 * now the floor rather than the top of the first band):
 * - 5 players: 1 Werewolf, 1 Seer, 1 Doctor, remainder Villagers
 * - 6-8 players: 2 Werewolves, 1 Seer, 1 Doctor, remainder Villagers
 * - 9-11 players: 3 Werewolves, 1 Seer, 1 Doctor, remainder Villagers
 * - 12+ players: Math.floor(playerCount / 4) Werewolves, 1 Seer, 1 Doctor, remainder Villagers
 */
export function getDefaultRoleConfig(playerCount: number): RoleConfigEntry[] {
  // Read the threshold from SETTINGS rather than repeating the literal, so the
  // guard and the start-time check can never disagree.
  const min = SETTINGS.gameplay.minStartablePlayers;
  if (playerCount < min) {
    throw new RangeError(
      `Minimum players for default role distribution is ${min} (got ${playerCount})`,
    );
  }

  let werewolfCount = 1;
  if (playerCount >= 12) {
    werewolfCount = Math.floor(playerCount / 4);
  } else if (playerCount >= 9) {
    werewolfCount = 3;
  } else if (playerCount >= 6) {
    werewolfCount = 2;
  }

  const seerCount = 1;
  const guardianAngelCount = 1;
  const villagerCount = playerCount - (werewolfCount + seerCount + guardianAngelCount);

  return [
    { roleKey: 'werewolf', roleCount: werewolfCount, config: {} },
    { roleKey: 'seer', roleCount: seerCount, config: {} },
    { roleKey: 'guardian_angel', roleCount: guardianAngelCount, config: {} },
    { roleKey: 'villager', roleCount: villagerCount, config: {} },
  ];
}
