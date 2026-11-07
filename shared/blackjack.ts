import type { Card } from '../server/game/cards.js';

export const BLACKJACK_RULES_VERSION = 'blackjack-duel-52-v1';
export type BlackjackSeat = 0 | 1;
export type BlackjackAction = { type: 'hit' } | { type: 'stand' };
export interface BlackjackHandValue { total: number; soft: boolean; blackjack: boolean; bust: boolean }
export type BlackjackReason = 'player-blackjack' | 'opponent-blackjack' | 'both-blackjack' | 'player-bust' | 'opponent-bust' | 'higher-total' | 'equal-total';
export interface BlackjackEvent { sequence: number; seat: BlackjackSeat; type: BlackjackAction['type']; card?: Card }
/** Private player observation. The remaining deck and opponent hole cards never cross this boundary. */
export interface BlackjackObservation {
  rulesVersion: typeof BLACKJACK_RULES_VERSION;
  seat: BlackjackSeat;
  hand: Card[];
  opponent: (Card | null)[];
  handValue: BlackjackHandValue;
  opponentValue: BlackjackHandValue | null;
  phase: 'play' | 'finished';
  turn: BlackjackSeat;
  stood: [boolean, boolean];
  /** Result is relative to human seat 0. Use winner for an arbitrary observation seat. */
  result: 'win' | 'loss' | 'push' | null;
  winner: BlackjackSeat | null;
  reason: BlackjackReason | null;
  revision: number;
  history: BlackjackEvent[];
}
export interface BlackjackRoomView extends BlackjackObservation { id: string; generation: number; thinking: boolean; error: string | null; model: string }
export interface BlackjackRoomGrant { room: BlackjackRoomView; token: string }
