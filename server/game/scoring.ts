import { identifyCombination } from './combos.js';
import type { GameState } from './game.js';

export interface Settlement {
  readonly version: 1;
  readonly baseScore: number;
  readonly callMultiplier: number;
  readonly bombCount: number;
  readonly rocketCount: number;
  readonly bombMultiplier: number;
  readonly spring: 'none' | 'spring' | 'anti-spring';
  readonly springMultiplier: number;
  readonly totalMultiplier: number;
  readonly unitScore: number;
  readonly landlord: number;
  readonly winner: 'landlord' | 'farmers';
  readonly players: readonly { readonly seat: number; readonly role: 'landlord' | 'farmer'; readonly delta: number }[];
}

export function validateBaseScore(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000000) throw new Error('Base score must be an integer between 1 and 1000000');
  return value;
}

export function calculateSettlement(state: GameState, baseScore = 1): Settlement {
  validateBaseScore(baseScore);
  if (state.phase !== 'finished' || !['landlord', 'farmers'].includes(state.winner ?? '') ||
    !Number.isInteger(state.landlord) || state.landlord < 0 || state.landlord > 2 || ![1, 2, 3].includes(state.callScore)) {
    throw new Error('Only a completed game can be settled');
  }
  const plays = state.logs.filter((entry) => entry.action === 'play');
  const finish = state.logs.at(-1);
  const winningPlay = plays.at(-1);
  if (!winningPlay || finish?.action !== 'finish' || finish.winner !== state.winner || finish.seat !== winningPlay.seat ||
    state.hands[finish.seat]?.length !== 0 || (finish.seat === state.landlord) !== (state.winner === 'landlord')) throw new Error('Invalid finished game');
  let bombCount = 0;
  let rocketCount = 0;
  const playCounts = [0, 0, 0];
  for (const play of plays) {
    const combination = identifyCombination(play.cards);
    if (!combination || !Number.isInteger(play.seat) || play.seat < 0 || play.seat > 2) throw new Error('Invalid play in settlement history');
    playCounts[play.seat] += 1;
    if (combination.type === 'bomb') bombCount += 1;
    if (combination.type === 'rocket') rocketCount += 1;
  }
  const spring = state.winner === 'landlord'
    ? playCounts.every((count, seat) => seat === state.landlord || count === 0) ? 'spring' : 'none'
    : playCounts[state.landlord] === 1 ? 'anti-spring' : 'none';
  const bombMultiplier = 2 ** (bombCount + rocketCount);
  const springMultiplier = spring === 'none' ? 1 : 2;
  const totalMultiplier = state.callScore * bombMultiplier * springMultiplier;
  const unitScore = baseScore * totalMultiplier;
  if (!Number.isSafeInteger(unitScore * 2)) throw new Error('Settlement exceeds safe integer limits');
  const players = [0, 1, 2].map((seat) => {
    const landlord = seat === state.landlord;
    const won = landlord === (state.winner === 'landlord');
    return { seat, role: landlord ? 'landlord' as const : 'farmer' as const, delta: unitScore * (landlord ? 2 : 1) * (won ? 1 : -1) };
  });
  return { version: 1, baseScore, callMultiplier: state.callScore, bombCount, rocketCount, bombMultiplier, spring, springMultiplier, totalMultiplier,
    unitScore, landlord: state.landlord, winner: state.winner!, players };
}
