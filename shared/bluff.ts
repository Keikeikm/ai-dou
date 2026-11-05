import type { Card } from '../server/game/cards.js';

export const BLUFF_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
export type BluffRank = typeof BLUFF_RANKS[number];
export type BluffSeat = 0 | 1;
export const BLUFF_RULES_VERSION = 'bluff-winner-leads-52-v2';
export const LEGACY_BLUFF_RULES_VERSION = 'bluff-sequential-52-v1';
export type BluffRulesVersion = typeof BLUFF_RULES_VERSION | typeof LEGACY_BLUFF_RULES_VERSION;
export type BluffAction = { type: 'play'; cards: string[] } | { type: 'accept' } | { type: 'challenge' };
export interface BluffClaim { seat: BluffSeat; rank: BluffRank; count: number }
export interface BluffReveal {
  challenger: BluffSeat;
  claimant: BluffSeat;
  rank: BluffRank;
  cards: Card[];
  lied: boolean;
  loser: BluffSeat;
  collected: number;
  /** The next leader decided by the engine; null means the match ended. */
  nextSeat?: BluffSeat | null;
}
export interface BluffEvent {
  sequence: number;
  seat: BluffSeat;
  type: BluffAction['type'];
  claim?: BluffClaim;
  reveal?: BluffReveal;
}
/** The only view supplied to a player or model. Never include the deck or seed. */
export interface BluffObservation {
  rulesVersion?: BluffRulesVersion;
  hand: Card[];
  opponentCount: number;
  seat: BluffSeat;
  turn: BluffSeat;
  phase: 'play' | 'respond' | 'finished';
  rank: BluffRank;
  pileCount: number;
  claim: BluffClaim | null;
  lastReveal: BluffReveal | null;
  winner: BluffSeat | null;
  revision: number;
  history: BluffEvent[];
}
export interface BluffRoomView extends BluffObservation {
  /** Challenge action awaiting the human's reveal acknowledgement. */
  revealPending?: number | null;
  id: string;
  generation: number;
  thinking: boolean;
  error: string | null;
  model: string;
}
export interface BluffRoomGrant { room: BluffRoomView; token: string }
