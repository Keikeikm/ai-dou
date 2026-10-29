import { describe, expect, it } from 'vitest';
import { cardsFromRanks } from '../server/game/cards.js';
import { createGame, type GameState } from '../server/game/game.js';
import { calculateSettlement, validateBaseScore } from '../server/game/scoring.js';
import { createDefaultBots } from '../server/agents/bots.js';
import { GameScheduler, replayJournal } from '../server/rooms/scheduler.js';

function finished(winner: 'landlord' | 'farmers', plays: readonly { seat: number; ranks: string[] }[], landlord = 0, score: 1 | 2 | 3 = 2): GameState {
  const state = createGame(7);
  const winningSeat = plays.at(-1)!.seat;
  const hands = [...state.hands] as GameState['hands'];
  hands[winningSeat] = [];
  return { ...state, hands, phase: 'finished', winner, landlord, callScore: score,
    logs: [...state.logs, ...plays.map((play) => ({ seat: play.seat, action: 'play' as const, cards: cardsFromRanks(play.ranks) })),
      { seat: winningSeat, action: 'finish', winner, cards: [] }] };
}

describe('Dou Dizhu scoring', () => {
  it.each([0, 1, 2])('settles a normal landlord victory with two shares against one share per farmer at seat %i', (landlord) => {
    const farmer = (landlord + 1) % 3;
    const state = finished('landlord', [{ seat: landlord, ranks: ['3'] }, { seat: farmer, ranks: ['4'] }, { seat: landlord, ranks: ['5'] }], landlord, 3);
    const before = structuredClone(state);
    const settlement = calculateSettlement(state, 5);
    expect(settlement).toMatchObject({ baseScore: 5, callMultiplier: 3, bombCount: 0, rocketCount: 0, spring: 'none', totalMultiplier: 3, unitScore: 15 });
    expect(settlement.players[landlord].delta).toBe(30);
    expect(settlement.players.filter((player) => player.seat !== landlord).map((player) => player.delta)).toEqual([-15, -15]);
    expect(settlement.players.reduce((sum, player) => sum + player.delta, 0)).toBe(0);
    expect(state).toEqual(before);
  });

  it('awards both farmers when only one empties their hand', () => {
    const settlement = calculateSettlement(finished('farmers', [{ seat: 0, ranks: ['3'] }, { seat: 0, ranks: ['5'] }, { seat: 2, ranks: ['6'] }]), 10);
    expect(settlement.spring).toBe('none');
    expect(settlement.players.map((player) => player.delta)).toEqual([-40, 20, 20]);
  });

  it('doubles once for every bomb and rocket, including the winning final play', () => {
    const state = finished('landlord', [
      { seat: 0, ranks: ['3', '3', '3', '3'] }, { seat: 1, ranks: ['4', '4', '4', '4'] },
      { seat: 0, ranks: ['little-joker', 'big-joker'] },
    ], 0, 3);
    expect(calculateSettlement(state, 2)).toMatchObject({ bombCount: 2, rocketCount: 1, bombMultiplier: 8, springMultiplier: 1, totalMultiplier: 24, unitScore: 48 });
    expect(calculateSettlement(state, 2).players.map((player) => player.delta)).toEqual([96, -48, -48]);
  });

  it('does not count accepted four-card bodies with attachments as bombs', () => {
    const state = finished('landlord', [
      { seat: 0, ranks: ['3', '3', '3', '3', '4', '5'] },
      { seat: 1, ranks: ['6', '6', '6', '6', '7', '7'] },
      { seat: 0, ranks: ['A'] },
    ]);
    expect(calculateSettlement(state)).toMatchObject({ bombCount: 0, rocketCount: 0, bombMultiplier: 1, spring: 'none' });
  });

  it('recognizes spring when neither farmer ever played, regardless of passes', () => {
    const state = finished('landlord', [{ seat: 0, ranks: ['3'] }, { seat: 0, ranks: ['4', '4', '4', '4'] }]);
    state.logs.splice(2, 0, { seat: 1, action: 'pass', cards: [] }, { seat: 2, action: 'pass', cards: [] });
    expect(calculateSettlement(state)).toMatchObject({ spring: 'spring', springMultiplier: 2, bombMultiplier: 2, totalMultiplier: 8 });
  });

  it.each([0, 1, 2])('recognizes anti-spring only when the landlord played exactly once at seat %i', (landlord) => {
    const farmer = (landlord + 1) % 3;
    const state = finished('farmers', [{ seat: landlord, ranks: ['3'] }, { seat: farmer, ranks: ['4'] }, { seat: farmer, ranks: ['5'] }], landlord, 1);
    const settlement = calculateSettlement(state);
    expect(settlement).toMatchObject({ spring: 'anti-spring', springMultiplier: 2, totalMultiplier: 2 });
    expect(settlement.players[landlord].delta).toBe(-4);
    expect(settlement.players.reduce((sum, player) => sum + player.delta, 0)).toBe(0);
  });

  it('combines rocket and spring multiplicatively instead of adding their multipliers', () => {
    expect(calculateSettlement(finished('landlord', [{ seat: 0, ranks: ['little-joker', 'big-joker'] }], 0, 3), 10))
      .toMatchObject({ rocketCount: 1, bombMultiplier: 2, springMultiplier: 2, totalMultiplier: 12, unitScore: 120 });
  });

  it.each([0, -1, 1.5, NaN, Infinity, 1000001])('rejects invalid base score %s', (baseScore) => {
    expect(() => validateBaseScore(baseScore)).toThrow();
  });

  it('rejects unfinished, inconsistent and unsafe settlement data', () => {
    expect(() => calculateSettlement(createGame(7))).toThrow(/completed/);
    const state = finished('landlord', [{ seat: 0, ranks: ['3'] }]);
    expect(() => calculateSettlement({ ...state, winner: 'farmers' })).toThrow(/finished/);
    expect(() => calculateSettlement({ ...state, landlord: 3 })).toThrow(/completed/);
    const manyBombs = Array.from({ length: 54 }, () => ({ seat: 0, ranks: ['3', '3', '3', '3'] }));
    expect(() => calculateSettlement(finished('landlord', manyBombs))).toThrow(/safe integer/);
  });

  it('reconstructs the same settlement from the journal and detects tampered claims', async () => {
    const scheduler = new GameScheduler(createDefaultBots(7), { baseScore: 7 });
    for (let turns = 0; turns < 300 && scheduler.getSession().status !== 'finished'; turns += 1) await scheduler.step();
    const journal = scheduler.getJournal();
    expect(journal.settlement?.baseScore).toBe(7);
    expect(replayJournal(journal)).toEqual(scheduler.getReplay().snapshots);
    expect(() => replayJournal({ ...journal, settlement: { ...journal.settlement!, totalMultiplier: 999 } })).toThrow(/does not match/);
    const legacy = { ...journal }; delete legacy.baseScore; delete legacy.settlement;
    expect(replayJournal(legacy).at(-1)?.settlement?.baseScore).toBe(1);
    scheduler.stop();
  });
});
