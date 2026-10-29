import { rankValue, type Card, type Rank } from '../game/cards.js';
import { canBeatCombination, identifyCombination, type Combination } from '../game/combos.js';
import type { CallScore, GameState } from '../game/game.js';

export type BotAction =
  | { readonly type: 'call'; readonly score: CallScore }
  | { readonly type: 'play'; readonly cards: Card[] }
  | { readonly type: 'pass' };

export interface Bot {
  readonly name: string;
  decide(state: GameState): BotAction;
}

export type RandomSource = () => number;

const RANKS: readonly Rank[] = [
  '3', '4', '5', '6', '7', '8', '9', '10',
  'J', 'Q', 'K', 'A', '2', 'little-joker', 'big-joker',
];

export function handStrength(hand: readonly Card[]): number {
  return hand.reduce((sum, card) => {
    const value = RANKS.indexOf(card.rank);
    return sum + (value >= 11 ? 3 : value >= 8 ? 2 : 1);
  }, 0);
}

function validCall(state: GameState, score: CallScore): boolean {
  return score === 0 || score > state.callScore;
}

interface RankGroup {
  readonly rank: number;
  readonly cards: Card[];
}

function choose<T>(items: readonly T[], count: number): T[][] {
  if (count === 0) return [[]];
  if (count < 0 || items.length < count) return [];

  const [first, ...rest] = items;
  return [
    ...choose(rest, count - 1).map((selection) => [first, ...selection]),
    ...choose(rest, count),
  ];
}

function groupByRank(hand: readonly Card[]): RankGroup[] {
  const groups = new Map<number, Card[]>();
  for (const card of hand) {
    const rank = rankValue(card.rank);
    groups.set(rank, [...(groups.get(rank) ?? []), card]);
  }
  return [...groups.entries()]
    .map(([rank, cards]) => ({ rank, cards }))
    .sort((left, right) => left.rank - right.rank);
}

function candidateSignature(cards: readonly Card[]): string {
  return cards
    .map((card) => rankValue(card.rank))
    .sort((left, right) => left - right)
    .join(',');
}

function consecutiveGroups(groups: readonly RankGroup[], minLength: number): RankGroup[][] {
  const sequences: RankGroup[][] = [];

  for (let start = 0; start < groups.length; start += 1) {
    const sequence: RankGroup[] = [];
    for (let index = start; index < groups.length; index += 1) {
      if (sequence.length > 0 && groups[index].rank !== groups[index - 1].rank + 1) break;
      if (groups[index].rank >= rankValue('2')) break;
      sequence.push(groups[index]);
      if (sequence.length >= minLength) sequences.push([...sequence]);
    }
  }

  return sequences;
}

function buildCandidateSets(hand: readonly Card[]): Card[][] {
  const groups = groupByRank(hand);
  const candidates: Card[][] = [];
  const seen = new Set<string>();

  const add = (cards: Card[]) => {
    const signature = candidateSignature(cards);
    if (seen.has(signature)) return;
    seen.add(signature);
    candidates.push(cards);
  };

  for (const group of groups) {
    add([group.cards[0]]);
    for (const pair of choose(group.cards, 2)) add(pair);
    for (const triple of choose(group.cards, 3)) add(triple);
    if (group.cards.length === 4) add([...group.cards]);

    for (const triple of choose(group.cards, 3)) {
      const used = new Set(triple.map((card) => card.id));
      for (const card of hand) {
        if (!used.has(card.id)) add([...triple, card]);
      }
      for (const other of groups) {
        if (other.rank === group.rank) continue;
        for (const pair of choose(other.cards, 2)) add([...triple, ...pair]);
      }
    }

    if (group.cards.length === 4) {
      const used = new Set(group.cards.map((card) => card.id));
      const remaining = hand.filter((card) => !used.has(card.id));
      for (const attachment of choose(remaining, 2)) add([...group.cards, ...attachment]);
    }
  }

  for (const sequence of consecutiveGroups(groups, 5)) {
    add(sequence.map((group) => group.cards[0]));
  }

  for (const sequence of consecutiveGroups(groups, 3)) {
    if (sequence.every((group) => group.cards.length >= 2)) {
      add(sequence.flatMap((group) => group.cards.slice(0, 2)));
    }
  }

  for (const sequence of consecutiveGroups(groups, 2)) {
    if (!sequence.every((group) => group.cards.length >= 3)) continue;
    const trioCards = sequence.flatMap((group) => group.cards.slice(0, 3));
    add(trioCards);

    const used = new Set(trioCards.map((card) => card.id));
    const remaining = hand.filter((card) => !used.has(card.id));
    for (const attachments of choose(remaining, sequence.length)) {
      add([...trioCards, ...attachments]);
    }
    for (const attachments of choose(remaining, sequence.length * 2)) {
      add([...trioCards, ...attachments]);
    }
  }

  const littleJoker = hand.find((card) => card.rank === 'little-joker');
  const bigJoker = hand.find((card) => card.rank === 'big-joker');
  if (littleJoker && bigJoker) add([littleJoker, bigJoker]);

  return candidates;
}

function playableCombinations(
  hand: readonly Card[],
  last?: Combination,
): { cards: Card[]; combination: Combination }[] {
  return buildCandidateSets(hand)
    .map((cards) => ({ cards, combination: identifyCombination(cards) }))
    .filter((candidate): candidate is { cards: Card[]; combination: Combination } =>
      candidate.combination !== undefined && canBeatCombination(candidate.combination, last),
    );
}

export function legalBotActions(state: GameState): BotAction[] {
  if (state.phase === 'finished') return [];
  if (state.phase === 'calling') return ([0, 1, 2, 3] as const).filter((score) => validCall(state, score)).map((score) => ({ type: 'call', score }));
  const plays: BotAction[] = playableCombinations(state.hands[state.currentSeat], state.lastPlay?.combination).map(({ combination }) => ({ type: 'play', cards: combination.cards }));
  return state.lastPlay ? [{ type: 'pass' }, ...plays] : plays;
}

export class RandomBot implements Bot {
  readonly name: string;
  private readonly random: RandomSource;

  constructor(name = 'Random Bot', random: RandomSource = Math.random) {
    this.name = name;
    this.random = random;
  }

  decide(state: GameState): BotAction {
    if (state.phase === 'calling') {
      const score = Math.floor(this.random() * 4) as CallScore;
      return { type: 'call', score: validCall(state, score) ? score : 0 };
    }

    if (state.phase !== 'playing') throw new Error(`${this.name} cannot act after the game is finished`);

    const playable = playableCombinations(state.hands[state.currentSeat], state.lastPlay?.combination);
    if (playable.length === 0) return { type: 'pass' };
    return { type: 'play', cards: playable[Math.floor(this.random() * playable.length)].cards };
  }
}

export class GreedyBot implements Bot {
  readonly name: string;

  constructor(name = 'Greedy Bot') {
    this.name = name;
  }

  decide(state: GameState): BotAction {
    if (state.phase === 'calling') {
      const strength = handStrength(state.hands[state.currentSeat]);
      if (strength >= 34) return { type: 'call', score: 3 };
      if (strength >= 30) return { type: 'call', score: Math.max(2, state.callScore + 1) as CallScore };
      if (strength >= 26) return { type: 'call', score: Math.max(1, state.callScore + 1) as CallScore };
      return { type: 'call', score: 0 };
    }

    if (state.phase !== 'playing') throw new Error(`${this.name} cannot act after the game is finished`);

    const playable = playableCombinations(state.hands[state.currentSeat], state.lastPlay?.combination);
    if (playable.length === 0) return { type: 'pass' };

    playable.sort((left, right) => {
      const sizeDifference = left.cards.length - right.cards.length;
      if (sizeDifference !== 0) return sizeDifference;
      return left.combination.rank - right.combination.rank;
    });

    return { type: 'play', cards: playable[0].cards };
  }
}

export function createDefaultBots(seed: number): [Bot, Bot, Bot] {
  return [
    new RandomBot('Random Bot', createSeededRandom(seed)),
    new GreedyBot('Greedy Bot'),
    new GreedyBot('Greedy Bot'),
  ];
}

function createSeededRandom(seed: number): () => number {
  let stateValue = seed >>> 0;
  return () => {
    stateValue = (stateValue * 1664525 + 1013904223) >>> 0;
    return stateValue / 0x100000000;
  };
}
