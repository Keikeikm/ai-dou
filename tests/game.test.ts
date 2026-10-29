import { describe, expect, it } from 'vitest';
import { cardsFromRanks, rankValue } from '../server/game/cards.js';
import { identifyCombination } from '../server/game/combos.js';
import { callScore, createGame, passTurn, playCards } from '../server/game/game.js';

describe('calling phase', () => {
  it('assigns the landlord immediately on a 3-point call', () => {
    let state = createGame(42);
    state = callScore(state, 0, 3);

    expect(state.phase).toBe('playing');
    expect(state.landlord).toBe(0);
    expect(state.callScore).toBe(3);
    expect(state.hands[0]).toHaveLength(20);
  });

  it('ends calling after three players and selects the highest caller', () => {
    let state = createGame(42);
    state = callScore(state, 0, 1);
    state = callScore(state, 1, 2);
    state = callScore(state, 2, 0);

    expect(state.phase).toBe('playing');
    expect(state.landlord).toBe(1);
    expect(state.callScore).toBe(2);
  });

  it('rejects acting out of turn and lower bids', () => {
    let state = createGame(42);

    expect(() => callScore(state, 1, 1)).toThrow(/current seat/);
    expect(() => callScore(state, 0, 0)).not.toThrow();
    state = callScore(state, 0, 0);
    state = callScore(state, 1, 2);
    expect(() => callScore(state, 2, 1)).toThrow(/greater than/);
  });
});

describe('playing phase', () => {
  function playingGame(): ReturnType<typeof callScore> {
    let state = createGame(7);
    state = callScore(state, 0, 3);
    return state;
  }

  it('plays valid cards and advances the turn', () => {
    let state = playingGame();
    const card = state.hands[0][0];
    state = playCards(state, 0, [card]);

    expect(state.currentSeat).toBe(1);
    expect(state.lastPlay?.seat).toBe(0);
    expect(state.hands[0]).toHaveLength(19);
  });

  it('rejects invalid combinations, cards not held, and losing plays', () => {
    let state = playingGame();
    state = playCards(state, 0, [state.hands[0][0]]);
    const leadingRank = state.lastPlay!.combination.cards[0].rank;
    const winningSingle = state.hands[1].findLast(
      (card) => rankValue(card.rank) > rankValue(leadingRank),
    );

    expect(() => playCards(state, 1, cardsFromRanks(['3', '4']))).toThrow(/Invalid cards/);
    expect(() => playCards(state, 2, [state.hands[1][0]])).toThrow(/current seat/);
    const foreignCard = { ...state.hands[1][0], id: 'foreign-card' };
    expect(() => playCards(state, 1, [foreignCard])).toThrow(/does not hold/);
    expect(winningSingle).toBeDefined();
    expect(() => playCards(state, 1, [winningSingle!])).not.toThrow();
  });

  it('allows passing only against an opponent lead', () => {
    let state = playingGame();
    state = playCards(state, 0, [state.hands[0][0]]);
    state = passTurn(state, 1);

    expect(state.currentSeat).toBe(2);
    state = passTurn(state, 2);
    expect(state.currentSeat).toBe(0);
    expect(state.lastPlay).toBeUndefined();
    expect(() => passTurn(state, 0)).toThrow(/leading player/);
  });

  it('finishes when a player runs out of cards', () => {
    let state = playingGame();
    const landlordHand = [...state.hands[0]];
    const finalCard = landlordHand[3];
    const leadingCards = landlordHand.filter(
      (_, index) => ![4, 5, 6, 18, 19].includes(index),
    );
    state = playCards(state, 0, leadingCards);
    state = passTurn(state, 1);
    state = passTurn(state, 2);
    for (const card of [landlordHand[4], landlordHand[5], landlordHand[6], landlordHand[18], landlordHand[19]]) {
      state = playCards(state, 0, [card]);
      if (state.phase === 'finished') break;
      state = passTurn(state, 1);
      state = passTurn(state, 2);
    }

    expect(state.phase).toBe('finished');
    expect(state.winner).toBe('landlord');
  });
});

