import { describe, expect, it } from 'vitest';
import { createDefaultBots, GreedyBot, RandomBot } from '../server/agents/bots.js';
import { cardsFromRanks, rankValue } from '../server/game/cards.js';
import { runBotGame } from '../server/agents/bot-game.js';
import { cardsFromRanks } from '../server/game/cards.js';
import { identifyCombination } from '../server/game/combos.js';
import { createGame } from '../server/game/game.js';

describe('RandomBot', () => {
  it('returns valid call actions', () => {
    const values = [0.0, 0.25, 0.5, 0.75, 0.99];
    let index = 0;
    const bot = new RandomBot('seeded', () => values[index++ % values.length]);
    let state = createGame(42);

    for (let turn = 0; turn < 3; turn += 1) {
      const action = bot.decide(state);
      expect(action.type).toBe('call');
      if (action.type !== 'call') throw new Error('unreachable');
      expect(action.score).toBeGreaterThanOrEqual(0);
      expect(action.score).toBeLessThanOrEqual(3);
      if (action.score !== 0) expect(action.score).toBeGreaterThan(state.callScore);
      state = {
        ...state,
        currentSeat: (state.currentSeat + 1) % 3,
        callScore: action.score === 0 ? state.callScore : action.score,
      };
    }
  });

  it('passes when it cannot beat the last play', () => {
    const state = createGame(42);
    const rocket = identifyCombination(cardsFromRanks(['X', 'D']));
    if (!rocket) throw new Error('rocket must be recognized');
    const playingState = {
      ...state,
      phase: 'playing' as const,
      lastPlay: { seat: 1, combination: rocket },
    };

    expect(new GreedyBot().decide(playingState)).toEqual({ type: 'pass' });
    expect(new RandomBot('random', () => 0).decide(playingState)).toEqual({ type: 'pass' });
  });
});

describe('GreedyBot', () => {
  it('prefers the smallest and lowest playable combination', () => {
    let state = createGame(7);
    state = { ...state, phase: 'playing' };
    const bot = new GreedyBot();
    const action = bot.decide(state);

    expect(action.type).toBe('play');
    if (action.type !== 'play') throw new Error('unreachable');
    expect(action.cards).toHaveLength(1);
    expect(rankValue(action.cards[0].rank)).toBe(
      Math.min(...state.hands[0].map((card) => rankValue(card.rank))),
    );
  });

  it('responds to a pair with the lowest playable pair', () => {
    const lastPair = identifyCombination(cardsFromRanks(['5', '5']));
    if (!lastPair) throw new Error('pair must be recognized');
    const state = {
      ...createGame(42),
      phase: 'playing' as const,
      hands: [
        cardsFromRanks(['6', '6', '7', '7', '9']),
        cardsFromRanks(['3', '4']),
        cardsFromRanks(['8', '8']),
      ],
      lastPlay: { seat: 1, combination: lastPair },
    };

    const action = new GreedyBot().decide(state);
    expect(action).toEqual({ type: 'play', cards: cardsFromRanks(['6', '6']) });
  });

  it('responds to three-with-a-pair with the lowest matching combination', () => {
    const lastPlay = identifyCombination(cardsFromRanks(['4', '4', '4', '5', '5']));
    if (!lastPlay) throw new Error('three-with-a-pair must be recognized');
    const state = {
      ...createGame(42),
      phase: 'playing' as const,
      hands: [
        cardsFromRanks(['6', '6', '6', '7', '7', '8', '8']),
        cardsFromRanks(['3', '4']),
        cardsFromRanks(['9', '9']),
      ],
      lastPlay: { seat: 1, combination: lastPlay },
    };

    const action = new GreedyBot().decide(state);
    expect(action).toEqual({ type: 'play', cards: cardsFromRanks(['6', '6', '6', '7', '7']) });
  });

  it('can enumerate straight and airplane candidates', () => {
    const state = {
      ...createGame(42),
      phase: 'playing' as const,
      hands: [
        cardsFromRanks(['4', '5', '6', '7', '8', '4', '5', '6', '7', '8']),
        cardsFromRanks(['8', '8']),
        cardsFromRanks(['9', '9']),
      ],
    };

    const action = new GreedyBot().decide(state);
    expect(action.type).toBe('play');
    if (action.type !== 'play') throw new Error('unreachable');
    expect(identifyCombination(action.cards)?.type).toBe('single');

    const straight = identifyCombination(cardsFromRanks(['3', '4', '5', '6', '7']));
    if (!straight) throw new Error('straight must be recognized');
    const straightState = {
      ...state,
      hands: [state.hands[0], state.hands[1], state.hands[2]],
      lastPlay: { seat: 1, combination: straight },
    };
    const straightAction = new GreedyBot().decide(straightState);
    expect(straightAction.type).toBe('play');
    if (straightAction.type !== 'play') throw new Error('unreachable');
    expect(identifyCombination(straightAction.cards)?.type).toBe('straight');

    const lastAirplane = identifyCombination(cardsFromRanks(['3', '3', '3', '4', '4', '4']));
    if (!lastAirplane) throw new Error('airplane must be recognized');
    const airplaneState = {
      ...state,
      hands: [
        cardsFromRanks(['4', '4', '4', '5', '5', '5', '6', '6', '6']),
        state.hands[1],
        state.hands[2],
      ],
      lastPlay: { seat: 1, combination: lastAirplane },
    };
    const airplaneAction = new GreedyBot().decide(airplaneState);
    expect(airplaneAction.type).toBe('play');
    if (airplaneAction.type !== 'play') throw new Error('unreachable');
    expect(identifyCombination(airplaneAction.cards)?.type).toBe('airplane');
  });
});

describe('bot games', () => {
  it.each([1, 2, 3, 5, 8, 13, 21, 34])('completes a full game with seed %i', (seed) => {
    const { state, actions } = runBotGame(createDefaultBots(seed), seed);

    expect(state.phase).toBe('finished');
    expect(['landlord', 'farmers']).toContain(state.winner);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((action) => action.seat >= 0 && action.seat <= 2)).toBe(true);
    expect(state.logs.some((entry) => entry.action === 'play')).toBe(true);
  });

  it('rejects bot actions that are illegal in the game state', () => {
    const state = createGame(42);
    const invalidBot = {
      name: 'Invalid Bot',
      decide: () => ({ type: 'play', cards: [] as never[] }) as const,
    };

    expect(() => runBotGame([invalidBot, invalidBot, invalidBot], 42)).toThrow(
      /returned play during calling/,
    );
  });
});
