export type Suit = 'spades' | 'hearts' | 'clubs' | 'diamonds';

export type Rank =
  | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10'
  | 'J' | 'Q' | 'K' | 'A' | '2' | 'little-joker' | 'big-joker';

export interface Card {
  readonly id: string;
  readonly rank: Rank;
  readonly suit: Suit | 'joker';
  readonly display: string;
}

const SUITS: readonly Suit[] = ['spades', 'hearts', 'clubs', 'diamonds'];
const SUIT_SYMBOLS: Record<Suit, string> = {
  spades: '\u2660',
  hearts: '\u2665',
  clubs: '\u2663',
  diamonds: '\u2666',
};

export const RANK_ORDER: readonly Rank[] = [
  '3', '4', '5', '6', '7', '8', '9', '10',
  'J', 'Q', 'K', 'A', '2', 'little-joker', 'big-joker',
];

export function rankValue(rank: Rank): number {
  return RANK_ORDER.indexOf(rank);
}

export function compareCards(left: Card, right: Card): number {
  return rankValue(left.rank) - rankValue(right.rank);
}

export function sortCards(cards: readonly Card[]): Card[] {
  return [...cards].sort(compareCards);
}

export function formatCards(cards: readonly Card[]): string {
  return sortCards(cards)
    .map((card) => card.display)
    .join(' ');
}

export function createDeck(): Card[] {
  const cards: Card[] = [];

  for (const suit of SUITS) {
    for (const rank of RANK_ORDER.slice(0, 13)) {
      cards.push({
        id: `${suit}-${rank}`,
        rank,
        suit,
        display: `${SUIT_SYMBOLS[suit]}${rank}`,
      });
    }
  }

  cards.push({
    id: 'joker-little',
    rank: 'little-joker',
    suit: 'joker',
    display: '\u5c0f\u738b',
  });
  cards.push({
    id: 'joker-big',
    rank: 'big-joker',
    suit: 'joker',
    display: '\u5927\u738b',
  });

  return cards;
}

export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

export interface DealtCards {
  readonly hands: readonly [Card[], Card[], Card[]];
  readonly bottomCards: Card[];
}

export function dealCards(deck: readonly Card[]): DealtCards {
  if (deck.length !== 54) {
    throw new Error(`A Dou Dizhu deck must contain 54 cards, received ${deck.length}`);
  }

  return {
    hands: [
      deck.slice(0, 17).map((card) => ({ ...card })),
      deck.slice(17, 34).map((card) => ({ ...card })),
      deck.slice(34, 51).map((card) => ({ ...card })),
    ],
    bottomCards: deck.slice(51).map((card) => ({ ...card })),
  };
}

const RANK_ALIASES: Record<string, Rank> = {
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9',
  '10': '10',
  J: 'J',
  Q: 'Q',
  K: 'K',
  A: 'A',
  '2': '2',
  'little-joker': 'little-joker',
  X: 'little-joker',
  '\u5c0f\u738b': 'little-joker',
  'big-joker': 'big-joker',
  D: 'big-joker',
  '\u5927\u738b': 'big-joker',
};

export function parseRank(value: string): Rank {
  const rank = RANK_ALIASES[value];
  if (!rank) {
    throw new Error(`Unknown rank: ${value}`);
  }
  return rank;
}

export function cardsFromRanks(rankText: readonly string[]): Card[] {
  const deck = createDeck();
  const used = new Set<string>();
  const cards: Card[] = [];

  for (const value of rankText) {
    const rank = parseRank(value);
    const card = deck.find((candidate) => candidate.rank === rank && !used.has(candidate.id));
    if (!card) {
      throw new Error(`No remaining card for rank: ${value}`);
    }
    used.add(card.id);
    cards.push({ ...card });
  }

  return sortCards(cards);
}

