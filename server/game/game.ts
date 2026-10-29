import {
  createDeck,
  dealCards,
  formatCards,
  rankValue,
  shuffle,
  type Card,
} from './cards.js';
import { canBeatCombination, identifyCombination, type Combination } from './combos.js';

export type Role = 'farmer' | 'landlord';
export type GamePhase = 'calling' | 'playing' | 'finished';
export type CallScore = 0 | 1 | 2 | 3;

export interface GameLogEntry {
  readonly seat: number;
  readonly action: 'deal' | 'call' | 'take-bottom' | 'play' | 'pass' | 'finish';
  readonly cards: readonly Card[];
  readonly score?: number | undefined;
  readonly winner?: 'landlord' | 'farmers' | undefined;
  readonly message?: string | undefined;
}

export interface GameState {
  readonly hands: [Card[], Card[], Card[]];
  readonly bottomCards: Card[];
  readonly landlord: number;
  readonly callScore: 1 | 2 | 3;
  readonly currentSeat: number;
  readonly phase: GamePhase;
  readonly lastPlay?: { readonly seat: number; readonly combination: Combination } | undefined;
  readonly winner?: 'landlord' | 'farmers' | undefined;
  readonly logs: GameLogEntry[];
  readonly passCount: number;
}

export function createGame(seed?: number): GameState {
  const random = seed === undefined ? Math.random : createSeededRandom(seed);
  const dealt = dealCards(shuffle(createDeck(), random));

  return {
    hands: dealt.hands as unknown as [Card[], Card[], Card[]],
    bottomCards: dealt.bottomCards,
    landlord: -1,
    callScore: 1,
    currentSeat: 0,
    phase: 'calling',
    logs: [
      {
        seat: 0,
        action: 'deal',
        cards: [],
        message: `\u624b\u724c: ${dealt.hands.map((hand) => formatCards(hand)).join(' | ')}`,
      },
    ],
    passCount: 0,
  };
}

export function callScore(state: GameState, seat: number, score: CallScore): GameState {
  if (state.phase !== 'calling') throw new Error('The calling phase is already finished');
  if (seat !== state.currentSeat) throw new Error(`Seat ${seat} cannot act; current seat is ${state.currentSeat}`);
  if (score !== 0 && score <= state.callScore && state.callScore !== 1) {
    throw new Error(`Call score must be 0 or greater than the current score ${state.callScore}`);
  }

  const called = state.logs.filter((entry) => entry.action === 'call');
  const nextSeat = (seat + 1) % 3;

  if (score === 3 || called.length === 2) {
    let landlord = seat;
    let callScoreValue: 1 | 2 | 3 = score === 0 ? 1 : score;
    if (score === 0) {
      const lastCall = [...called].reverse().find((entry) => entry.score && entry.score > 0);
      if (!lastCall) {
        landlord = nextSeat;
        callScoreValue = 1;
      } else {
        landlord = lastCall.seat;
        callScoreValue = lastCall.score as 1 | 2 | 3;
      }
    }

    return startPlaying(state, landlord, callScoreValue, seat, score);
  }

  return {
    ...state,
    currentSeat: nextSeat,
    callScore: score === 0 ? state.callScore : score,
    logs: [
      ...state.logs,
      {
        seat,
        action: 'call',
        cards: [],
        score,
        message: score === 0 ? '\u4e0d\u53eb' : `\u53eb ${score} \u5206`,
      },
    ],
  };
}

function startPlaying(
  state: GameState,
  landlord: number,
  score: 1 | 2 | 3,
  lastCallSeat: number,
  lastCallScore: CallScore,
): GameState {
  const hands = [...state.hands] as [Card[], Card[], Card[]];
  hands[landlord] = [...hands[landlord], ...state.bottomCards].sort(
    (left, right) => rankValue(left.rank) - rankValue(right.rank),
  );

  return {
    ...state,
    hands,
    landlord,
    callScore: score,
    currentSeat: landlord,
    phase: 'playing',
    passCount: 0,
    logs: [
      ...state.logs,
      { seat: lastCallSeat, action: 'call', cards: [], score: lastCallScore },
      {
        seat: landlord,
        action: 'take-bottom',
        cards: state.bottomCards,
        message: `\u6210\u4e3a\u5730\u4e3b\uff0c\u5e95\u724c: ${formatCards(state.bottomCards)}`,
      },
    ],
  };
}

export function playCards(state: GameState, seat: number, cards: readonly Card[]): GameState {
  if (state.phase !== 'playing') throw new Error('Cards can only be played during the playing phase');
  if (seat !== state.currentSeat) throw new Error(`Seat ${seat} cannot act; current seat is ${state.currentSeat}`);

  const combination = identifyCombination(cards);
  if (!combination) throw new Error(`Invalid cards: ${formatCards(cards)}`);
  if (!containsCards(state.hands[seat], cards)) throw new Error(`Seat ${seat} does not hold those cards`);
  if (!canBeatCombination(combination, state.lastPlay?.combination)) {
    throw new Error(`Cards cannot beat the previous play: ${formatCards(cards)}`);
  }

  const hands = [...state.hands] as [Card[], Card[], Card[]];
  hands[seat] = removeCards(hands[seat], cards);

  const logs: GameLogEntry[] = [
    ...state.logs,
    { seat, action: 'play', cards: [...combination.cards] },
  ];

  if (hands[seat].length === 0) {
    const winner = seat === state.landlord ? 'landlord' : 'farmers';
    return {
      ...state,
      hands,
      phase: 'finished',
      lastPlay: { seat, combination },
      passCount: 0,
      winner,
      logs: [
        ...logs,
        {
          seat,
          action: 'finish',
          cards: [],
          winner,
          message:
            seat === state.landlord
              ? '\u5730\u4e3b\u80dc\u5229'
              : '\u519c\u6c11\u80dc\u5229',
        },
      ],
    };
  }

  return {
    ...state,
    hands,
    currentSeat: (seat + 1) % 3,
    lastPlay: { seat, combination },
    passCount: 0,
    logs,
  };
}

export function passTurn(state: GameState, seat: number): GameState {
  if (state.phase !== 'playing') throw new Error('Turns can only be passed during the playing phase');
  if (seat !== state.currentSeat) throw new Error(`Seat ${seat} cannot act; current seat is ${state.currentSeat}`);
  if (!state.lastPlay || state.lastPlay.seat === seat) {
    throw new Error('The leading player cannot pass');
  }

  const nextPassCount = state.passCount + 1;
  const shouldReset = nextPassCount >= 2;
  const nextSeat = shouldReset ? state.lastPlay.seat : (seat + 1) % 3;

  return {
    ...state,
    currentSeat: nextSeat,
    lastPlay: shouldReset ? undefined : state.lastPlay,
    passCount: shouldReset ? 0 : nextPassCount,
    logs: [
      ...state.logs,
      {
        seat,
        action: 'pass',
        cards: [],
        message: '\u4e0d\u51fa',
      } satisfies GameLogEntry,
    ],
  };
}

function containsCards(hand: readonly Card[], cards: readonly Card[]): boolean {
  const remaining = [...hand];
  for (const card of cards) {
    const index = remaining.findIndex((candidate) => candidate.id === card.id);
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return true;
}

function removeCards(hand: readonly Card[], cards: readonly Card[]): Card[] {
  const remaining = [...hand];
  for (const card of cards) {
    const index = remaining.findIndex((candidate) => candidate.id === card.id);
    if (index === -1) throw new Error(`Card not found: ${card.id}`);
    remaining.splice(index, 1);
  }
  return remaining;
}

function createSeededRandom(seed: number): () => number {
  let stateValue = seed >>> 0;
  return () => {
    stateValue = (stateValue * 1664525 + 1013904223) >>> 0;
    return stateValue / 0x100000000;
  };
}

