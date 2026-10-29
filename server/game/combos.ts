import { compareCards, rankValue, type Card, type Rank } from './cards.js';

export type CombinationType =
  | 'single'
  | 'pair'
  | 'triple'
  | 'triple-single'
  | 'triple-pair'
  | 'straight'
  | 'pair-straight'
  | 'airplane'
  | 'airplane-single'
  | 'airplane-pair'
  | 'four-with-two'
  | 'four-with-two-pairs'
  | 'bomb'
  | 'rocket';

export interface Combination {
  readonly type: CombinationType;
  readonly cards: Card[];
  readonly rank: number;
  readonly length: number;
}

interface RankGroup {
  readonly rank: number;
  readonly rankText: Rank;
  readonly cards: Card[];
}

function groupByRank(cards: readonly Card[]): RankGroup[] {
  const groups = new Map<number, RankGroup>();

  for (const card of cards) {
    const rank = rankValue(card.rank);
    const existing = groups.get(rank);
    if (existing) {
      groups.set(rank, {
        ...existing,
        cards: [...existing.cards, card],
      });
    } else {
      groups.set(rank, { rank, rankText: card.rank, cards: [card] });
    }
  }

  return [...groups.values()].sort((left, right) => compareCards(left.cards[0], right.cards[0]));
}

function isStraightSequence(rankGroups: readonly RankGroup[], count: number): boolean {
  if (rankGroups.length < 2) return false;
  if (rankGroups.some((group) => group.cards.length !== count || group.rank >= rankValue('2'))) return false;

  for (let index = 1; index < rankGroups.length; index += 1) {
    if (rankGroups[index].rank - rankGroups[index - 1].rank !== 1) return false;
  }
  return true;
}

function isAirplaneSequence(rankGroups: readonly RankGroup[], trioCount: number): boolean {
  const trios = rankGroups.filter((group) => group.cards.length === 3);
  if (trios.length !== trioCount) return false;
  if (trios.some((group) => group.rank >= rankValue('2'))) return false;

  for (let index = 1; index < trios.length; index += 1) {
    if (trios[index].rank - trios[index - 1].rank !== 1) return false;
  }
  return true;
}

function isRocket(rankGroups: readonly RankGroup[]): boolean {
  return (
    rankGroups.length === 2 &&
    rankGroups[0].rankText === 'little-joker' &&
    rankGroups[1].rankText === 'big-joker'
  );
}

function airplaneWithSingles(cards: readonly Card[], rankGroups: readonly RankGroup[]): Combination | undefined {
  if (rankGroups.length < 4 || cards.length % 4 !== 0) return undefined;

  const trioCount = cards.length / 4;
  if (trioCount < 2) return undefined;

  const trioGroups = rankGroups.filter((group) => group.cards.length === 3);
  if (!isAirplaneSequence(trioGroups, trioCount)) return undefined;

  const extraCards = cards.length - trioCount * 3;
  const trioRanks = new Set(trioGroups.map((group) => group.rank));
  const remaining = rankGroups.filter((group) => !trioRanks.has(group.rank));
  let remainingCount = 0;
  for (const group of remaining) remainingCount += group.cards.length;

  if (remainingCount !== extraCards) return undefined;

  if (remaining.some((group) => group.cards.length === 4 && group.cards.length > extraCards)) {
    return undefined;
  }

  return {
    type: 'airplane-single',
    cards: [...cards],
    rank: trioGroups[0].rank,
    length: trioCount,
  };
}

function airplaneWithPairs(cards: readonly Card[], rankGroups: readonly RankGroup[]): Combination | undefined {
  if (rankGroups.length < 4 || cards.length % 5 !== 0) return undefined;

  const trioCount = cards.length / 5;
  if (trioCount < 2) return undefined;

  const trioGroups = rankGroups.filter((group) => group.cards.length === 3);
  if (!isAirplaneSequence(trioGroups, trioCount)) return undefined;

  const trioRanks = new Set(trioGroups.map((group) => group.rank));
  const remaining = rankGroups.filter((group) => !trioRanks.has(group.rank));
  if (remaining.some((group) => group.cards.length !== 2)) return undefined;
  if (remaining.length !== trioCount) return undefined;

  return {
    type: 'airplane-pair',
    cards: [...cards],
    rank: trioGroups[0].rank,
    length: trioCount,
  };
}

export function identifyCombination(cards: readonly Card[]): Combination | undefined {
  if (cards.length === 0) return undefined;

  const sorted = [...cards].sort(compareCards);
  const groups = groupByRank(sorted);
  const rank = groups[0].rank;
  const uniqueRanks = groups.length;

  if (isRocket(groups)) {
    return { type: 'rocket', cards: sorted, rank, length: 1 };
  }

  if (uniqueRanks === 1) {
    const count = cards.length;
    if (count === 1) return { type: 'single', cards: sorted, rank, length: 1 };
    if (count === 2) return { type: 'pair', cards: sorted, rank, length: 1 };
    if (count === 3) return { type: 'triple', cards: sorted, rank, length: 1 };
    if (count === 4) return { type: 'bomb', cards: sorted, rank, length: 1 };
  }

  if (uniqueRanks === 2 && cards.length === 4) {
    const trio = groups.find((group) => group.cards.length === 3);
    const single = groups.find((group) => group.cards.length === 1);
    if (trio && single) {
      return { type: 'triple-single', cards: sorted, rank: trio.rank, length: 1 };
    }
  }

  if (uniqueRanks === 2 && cards.length === 5) {
    const trio = groups.find((group) => group.cards.length === 3);
    const pair = groups.find((group) => group.cards.length === 2);
    if (trio && pair) {
      return { type: 'triple-pair', cards: sorted, rank: trio.rank, length: 1 };
    }
  }

  if (uniqueRanks === 3 && cards.length === 6) {
    const four = groups.find((group) => group.cards.length === 4);
    if (four) {
      const others = groups.filter((group) => group !== four);
      if (others.length === 2 && others.every((group) => group.cards.length === 1)) {
        return { type: 'four-with-two', cards: sorted, rank: four.rank, length: 1 };
      }
      if (others.length === 1 && others[0].cards.length === 2) {
        return { type: 'four-with-two-pairs', cards: sorted, rank: four.rank, length: 1 };
      }
    }
  }

  if (uniqueRanks === 2 && cards.length === 6) {
    const four = groups.find((group) => group.cards.length === 4);
    if (four) {
      const pair = groups.find((group) => group.cards.length === 2);
      if (pair) {
        return { type: 'four-with-two-pairs', cards: sorted, rank: four.rank, length: 1 };
      }
    }
  }

  if (uniqueRanks >= 5 && isStraightSequence(groups, 1)) {
    return { type: 'straight', cards: sorted, rank, length: groups.length };
  }

  if (uniqueRanks >= 3 && isStraightSequence(groups, 2)) {
    return { type: 'pair-straight', cards: sorted, rank, length: groups.length };
  }

  const airplane = airplaneWithSingles(sorted, groups) ?? airplaneWithPairs(sorted, groups);
  if (airplane) return airplane;

  if (uniqueRanks === 3 && cards.length === 6 && groups.every((group) => group.cards.length === 2)) {
    return { type: 'pair-straight', cards: sorted, rank, length: groups.length };
  }

  const trios = groups.filter((group) => group.cards.length === 3);
  if (trios.length >= 2 && cards.length === trios.length * 3 && isAirplaneSequence(trios, trios.length)) {
    return { type: 'airplane', cards: sorted, rank: trios[0].rank, length: trios.length };
  }

  return undefined;
}

export function canBeatCombination(play: Combination, last?: Combination): boolean {
  if (!last) return true;

  if (play.type === 'rocket') return true;
  if (last.type === 'rocket') return false;

  if (play.type === 'bomb') {
    if (last.type === 'bomb') return play.rank > last.rank;
    return true;
  }

  if (last.type === 'bomb') return false;
  if (play.type !== last.type || play.length !== last.length) return false;
  return play.rank > last.rank;
}

