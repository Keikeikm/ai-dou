import { createDeck, shuffle, type Card } from '../game/cards.js';
import { BLUFF_RANKS, BLUFF_RULES_VERSION, type BluffRulesVersion, type BluffAction, type BluffClaim, type BluffEvent, type BluffObservation, type BluffReveal, type BluffSeat } from '../../shared/bluff.js';

export interface BluffState {
  rulesVersion: BluffRulesVersion;
  hands: [Card[], Card[]];
  pile: Card[];
  pending: (BluffClaim & { cards: Card[] }) | null;
  turn: BluffSeat;
  phase: BluffObservation['phase'];
  rankIndex: number;
  winner: BluffSeat | null;
  revision: number;
  history: BluffEvent[];
  lastReveal: BluffReveal | null;
}

export function createBluffGame(random: () => number = Math.random, rulesVersion: BluffRulesVersion = BLUFF_RULES_VERSION): BluffState {
  const deck = shuffle(createDeck().filter((card) => card.suit !== 'joker'), random);
  return { rulesVersion, hands: [deck.slice(0, 26), deck.slice(26)], pile: [], pending: null, turn: 0, phase: 'play', rankIndex: 0,
    winner: null, revision: 0, history: [], lastReveal: null };
}

export function validateBluffAction(state: BluffState, seat: BluffSeat, input: unknown): BluffAction {
  if (state.phase === 'finished') throw new Error('本局已经结束，请再来一局。');
  if (state.turn !== seat) throw new Error('还没轮到你行动。');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('无效动作。');
  const action = input as Record<string, unknown>;
  if (state.phase === 'respond') {
    if ((action.type !== 'accept' && action.type !== 'challenge') || Object.keys(action).length !== 1) throw new Error('请选择相信或质疑。');
    return { type: action.type };
  }
  if (action.type !== 'play' || Object.keys(action).length !== 2 || !Array.isArray(action.cards)
    || action.cards.length < 1 || action.cards.length > 4 || new Set(action.cards).size !== action.cards.length
    || action.cards.some((id) => typeof id !== 'string' || !state.hands[seat].some((card) => card.id === id))) {
    throw new Error('请选择自己手中的 1–4 张不同的牌。');
  }
  return { type: 'play', cards: [...action.cards] as string[] };
}

export function applyBluffAction(state: BluffState, seat: BluffSeat, input: unknown): void {
  const action = validateBluffAction(state, seat, input);
  const event: BluffEvent = { sequence: ++state.revision, seat, type: action.type };
  if (action.type === 'play') {
    const cards = state.hands[seat].filter((card) => action.cards.includes(card.id));
    state.hands[seat] = state.hands[seat].filter((card) => !action.cards.includes(card.id));
    state.pile.push(...cards);
    const claim = { seat, rank: BLUFF_RANKS[state.rankIndex], count: cards.length };
    state.pending = { ...claim, cards };
    event.claim = claim;
    state.turn = seat === 0 ? 1 : 0;
    state.phase = 'respond';
  } else {
    const claim = state.pending!;
    // Accepting hands the lead to the responder. A challenge awards the lead
    // to its winner; legacy archives retain the original responder-leads rule.
    state.turn = seat;
    if (action.type === 'challenge') {
      const lied = claim.cards.some((card) => card.rank !== claim.rank);
      const loser = lied ? claim.seat : seat;
      state.lastReveal = { challenger: seat, claimant: claim.seat, rank: claim.rank, cards: [...claim.cards], lied, loser, collected: state.pile.length };
      event.reveal = state.lastReveal;
      state.hands[loser].push(...state.pile);
      state.pile = [];
      if (state.rulesVersion === BLUFF_RULES_VERSION) state.turn = loser === 0 ? 1 : 0;
    }
    // The final claim must survive the response before its player can win.
    if (state.hands[claim.seat].length === 0) {
      state.winner = claim.seat;
      state.phase = 'finished';
    } else {
      state.phase = 'play';
      state.rankIndex = (state.rankIndex + 1) % BLUFF_RANKS.length;
    }
    if (event.reveal) event.reveal.nextSeat = state.phase === 'finished' ? null : state.turn;
    state.pending = null;
  }
  state.history.push(event);
}

export function observeBluff(state: BluffState, seat: BluffSeat): BluffObservation {
  const claim = state.pending;
  return structuredClone({ rulesVersion: state.rulesVersion, hand: state.hands[seat], opponentCount: state.hands[seat === 0 ? 1 : 0].length, seat,
    turn: state.turn, phase: state.phase, rank: BLUFF_RANKS[state.rankIndex], pileCount: state.pile.length,
    claim: claim ? { seat: claim.seat, rank: claim.rank, count: claim.count } : null,
    lastReveal: state.lastReveal, winner: state.winner, revision: state.revision, history: state.history.slice(-60) });
}
