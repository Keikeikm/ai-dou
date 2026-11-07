import { createDeck, shuffle, type Card } from '../game/cards.js';
import { BLACKJACK_RULES_VERSION, type BlackjackAction, type BlackjackEvent, type BlackjackHandValue, type BlackjackObservation, type BlackjackReason, type BlackjackSeat } from '../../shared/blackjack.js';

export interface BlackjackState {
  rulesVersion: typeof BLACKJACK_RULES_VERSION;
  initialDeck: Card[];
  deck: Card[];
  hands: [Card[], Card[]];
  phase: 'play' | 'finished';
  turn: BlackjackSeat;
  stood: [boolean, boolean];
  winner: BlackjackSeat | null;
  result: BlackjackObservation['result'];
  reason: BlackjackReason | null;
  revision: number;
  history: BlackjackEvent[];
}

export function handValue(cards: readonly Card[]): BlackjackHandValue {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (card.rank === 'A') { total += 11; aces++; }
    else if (['J', 'Q', 'K'].includes(card.rank)) total += 10;
    else if (/^(?:[2-9]|10)$/.test(card.rank)) total += Number(card.rank);
    else throw new Error('21 点不能使用大小王。');
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return { total, soft: aces > 0, blackjack: cards.length === 2 && total === 21, bust: total > 21 };
}

function settle(state: BlackjackState, winner: BlackjackSeat | null, reason: BlackjackReason) {
  state.phase = 'finished'; state.winner = winner; state.reason = reason;
  state.result = winner === null ? 'push' : winner === 0 ? 'win' : 'loss';
}

/** The supplied deck is a complete, ordered 52-card deck; deal from its front in seat order. */
export function createBlackjackGame(orderedDeck?: Card[]): BlackjackState {
  const canonical = createDeck().filter((card) => card.suit !== 'joker');
  const deck = structuredClone(orderedDeck ?? shuffle(canonical));
  if (deck.length !== 52 || new Set(deck.map((card) => card.id)).size !== 52 || deck.some((card) => !canonical.some((item) => item.id === card.id && item.suit === card.suit && item.rank === card.rank))) throw new Error('21 点需要完整的一副 52 张牌。');
  const state: BlackjackState = { rulesVersion: BLACKJACK_RULES_VERSION, initialDeck: structuredClone(deck), deck: deck.slice(4), hands: [[deck[0], deck[2]], [deck[1], deck[3]]],
    phase: 'play', turn: 0, stood: [false, false], winner: null, result: null, reason: null, revision: 0, history: [] };
  const human = handValue(state.hands[0]); const opponent = handValue(state.hands[1]);
  if (human.blackjack && opponent.blackjack) settle(state, null, 'both-blackjack');
  else if (human.blackjack) settle(state, 0, 'player-blackjack');
  else if (opponent.blackjack) settle(state, 1, 'opponent-blackjack');
  return state;
}

export function validateBlackjackAction(state: BlackjackState, seat: BlackjackSeat, input: unknown): BlackjackAction {
  if (state.phase === 'finished') throw new Error('本局已经结束，请再来一局。');
  if (state.turn !== seat || state.stood[seat]) throw new Error('还没轮到你行动。');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请选择要牌或停牌。');
  const action = input as Record<string, unknown>;
  if ((action.type !== 'hit' && action.type !== 'stand') || Object.keys(action).length !== 1) throw new Error('请选择要牌或停牌。');
  if (action.type === 'hit' && !state.deck.length) throw new Error('牌堆已空。');
  return { type: action.type };
}

export function applyBlackjackAction(state: BlackjackState, seat: BlackjackSeat, input: unknown): void {
  const action = validateBlackjackAction(state, seat, input);
  const event: BlackjackEvent = { sequence: ++state.revision, seat, type: action.type };
  if (action.type === 'stand') state.stood[seat] = true;
  else {
    const card = state.deck.shift()!;
    state.hands[seat].push(card); event.card = card;
    const value = handValue(state.hands[seat]);
    if (value.bust) settle(state, seat === 0 ? 1 : 0, seat === 0 ? 'player-bust' : 'opponent-bust');
    else if (value.total === 21) state.stood[seat] = true;
  }
  state.history.push(event);
  if (state.phase === 'finished') return;
  if (state.stood.every(Boolean)) {
    const difference = handValue(state.hands[0]).total - handValue(state.hands[1]).total;
    settle(state, difference === 0 ? null : difference > 0 ? 0 : 1, difference === 0 ? 'equal-total' : 'higher-total');
  } else {
    const other = seat === 0 ? 1 : 0;
    state.turn = state.stood[other] ? seat : other;
  }
}

export function observeBlackjack(state: BlackjackState, seat: BlackjackSeat = 0): BlackjackObservation {
  const opponent = seat === 0 ? 1 : 0;
  const finished = state.phase === 'finished';
  return structuredClone({ rulesVersion: state.rulesVersion, seat, hand: state.hands[seat],
    opponent: state.hands[opponent].map((card, index) => finished || index === 0 ? card : null), handValue: handValue(state.hands[seat]),
    opponentValue: finished ? handValue(state.hands[opponent]) : null, phase: state.phase, turn: state.turn, stood: state.stood,
    result: state.result, winner: state.winner, reason: state.reason, revision: state.revision,
    history: state.history.map(({ card, ...event }) => ({ ...event, ...(card && (finished || event.seat === seat) ? { card } : {}) })) });
}
