import { describe, expect, it } from 'vitest';
import { cardsFromRanks, createDeck, dealCards, formatCards, shuffle } from '../server/game/cards.js';
import { canBeatCombination, identifyCombination } from '../server/game/combos.js';

describe('cards', () => {
  it('creates a complete 54-card deck', () => {
    const deck = createDeck();
    expect(deck).toHaveLength(54);
    expect(new Set(deck.map((card) => card.id)).size).toBe(54);
  });

  it('deals 17 cards to each player and 3 bottom cards', () => {
    const dealt = dealCards(shuffle(createDeck(), () => 0.42));
    expect(dealt.hands.map((hand) => hand.length)).toEqual([17, 17, 17]);
    expect(dealt.bottomCards).toHaveLength(3);
  });

  it('rejects dealing with an invalid deck', () => {
    expect(() => dealCards(createDeck().slice(1))).toThrow(/54 cards/);
  });

  it('formats cards by rank', () => {
    const jokers = formatCards(cardsFromRanks(['X', 'D']));
    expect(jokers.startsWith('\u5c0f\u738b')).toBe(true);
    expect(jokers.endsWith('\u5927\u738b')).toBe(true);
  });
});

describe('combination identification', () => {
  const cases: [string[], ReturnType<typeof identifyCombination>['type'] | undefined][] = [
    [['A'], 'single'],
    [['7', '7'], 'pair'],
    [['9', '9', '9'], 'triple'],
    [['9', '9', '9', 'J'], 'triple-single'],
    [['9', '9', '9', 'J', 'J'], 'triple-pair'],
    [['3', '4', '5', '6', '7'], 'straight'],
    [['3', '3', '4', '4', '5', '5'], 'pair-straight'],
    [['3', '3', '3', '4', '4', '4'], 'airplane'],
    [['3', '3', '3', '4', '4', '4', '5', '6'], 'airplane-single'],
    [['3', '3', '3', '4', '4', '4', '5', '5', '6', '6'], 'airplane-pair'],
    [['9', '9', '9', '9', '3', '4'], 'four-with-two'],
    [['9', '9', '9', '9', '3', '3'], 'four-with-two-pairs'],
    [['9', '9', '9', '9'], 'bomb'],
    [['X', 'D'], 'rocket'],
    [['2', '2', '2'], 'triple'],
    [['3', '4', '5', '6'], undefined],
    [['3', '3', '4', '4', '5'], undefined],
    [['X', 'D', '3'], undefined],
  ];

  it.each(cases)('identifies %s', (ranks, expected) => {
    const combination = identifyCombination(cardsFromRanks(ranks));
    expect(combination?.type).toBe(expected);
  });
});

describe('combination comparison', () => {
  it('requires the same type and length', () => {
    const pair = identifyCombination(cardsFromRanks(['5', '5']));
    const trio = identifyCombination(cardsFromRanks(['4', '4', '4']));
    expect(canBeatCombination(trio!, pair!)).toBe(false);
  });

  it('only lets higher ranks beat the same type', () => {
    const low = identifyCombination(cardsFromRanks(['5', '5']));
    const high = identifyCombination(cardsFromRanks(['6', '6']));
    const same = identifyCombination(cardsFromRanks(['5', '5']));
    expect(canBeatCombination(high!, low!)).toBe(true);
    expect(canBeatCombination(same!, low!)).toBe(false);
  });

  it('lets bombs and rockets beat normal combinations', () => {
    const pair = identifyCombination(cardsFromRanks(['A', 'A']));
    const bomb = identifyCombination(cardsFromRanks(['3', '3', '3', '3']));
    const rocket = identifyCombination(cardsFromRanks(['X', 'D']));
    expect(canBeatCombination(bomb!, pair!)).toBe(true);
    expect(canBeatCombination(rocket!, bomb!)).toBe(true);
    expect(canBeatCombination(bomb!, rocket!)).toBe(false);
  });
});
