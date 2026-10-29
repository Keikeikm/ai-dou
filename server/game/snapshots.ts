import type { Card } from './cards.js';
import type { GameState } from './game.js';
import { calculateSettlement, type Settlement } from './scoring.js';

export interface GameSnapshot {
  readonly phase: GameState['phase'];
  readonly currentSeat: number;
  readonly landlord: number;
  readonly callScore: number;
  readonly hands: readonly (readonly Card[])[];
  readonly bottomCards: readonly Card[];
  readonly lastPlay?: { readonly seat: number; readonly cards: readonly Card[]; readonly type: string } | undefined;
  readonly winner?: GameState['winner'];
  readonly logs: readonly GameState['logs'][number][];
  readonly players: readonly string[];
  readonly settlement?: Settlement;
}

export function captureSnapshot(state: GameState, players: readonly string[], baseScore = 1): GameSnapshot {
  return structuredClone({
    phase: state.phase,
    currentSeat: state.currentSeat,
    landlord: state.landlord,
    callScore: state.callScore,
    hands: state.hands,
    bottomCards: state.bottomCards,
    lastPlay: state.lastPlay ? {
      seat: state.lastPlay.seat,
      cards: state.lastPlay.combination.cards,
      type: state.lastPlay.combination.type,
    } : undefined,
    winner: state.winner,
    logs: state.logs,
    players,
    ...(state.phase === 'finished' ? { settlement: calculateSettlement(state, baseScore) } : {}),
  });
}
