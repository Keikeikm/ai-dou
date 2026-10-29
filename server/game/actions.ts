import type { BotAction } from '../agents/bots.js';
import { callScore, passTurn, playCards, type GameState } from './game.js';

export function applyGameAction(state: GameState, seat: number, action: BotAction): GameState {
  if (!action || typeof action !== 'object') throw new Error('Missing action');
  if (action.type === 'call' && state.phase === 'calling') {
    if (![0, 1, 2, 3].includes(action.score)) throw new Error('Invalid call score');
    return callScore(state, seat, action.score);
  }
  if (action.type === 'pass' && state.phase === 'playing') return passTurn(state, seat);
  if (action.type === 'play' && state.phase === 'playing') {
    if (!Array.isArray(action.cards) || action.cards.length === 0 || action.cards.length > 20) {
      throw new Error('Invalid card list');
    }
    const cards = action.cards.map((card) => {
      const held = state.hands[seat]?.find((candidate) => candidate.id === card?.id);
      if (!held) throw new Error('Player does not hold those cards');
      return held;
    });
    return playCards(state, seat, cards);
  }
  throw new Error(`returned ${action.type} during ${state.phase}`);
}
