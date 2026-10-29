import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultBots, legalBotActions, type BotAction } from '../server/agents/bots.js';
import { rankValue } from '../server/game/cards.js';
import { identifyCombination } from '../server/game/combos.js';
import { runReplayGame } from '../server/agents/bot-game.js';
import { GameScheduler, replayJournal, type DecisionAgent } from '../server/rooms/scheduler.js';

describe('authoritative game scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('uses random initial deals by default while keeping explicit seeds replayable', () => {
    const first = new GameScheduler(createDefaultBots(7));
    const second = new GameScheduler(createDefaultBots(7));
    expect(first.getReplay().snapshots[0].hands).not.toEqual(second.getReplay().snapshots[0].hands);
    expect(replayJournal(first.getJournal())).toEqual(first.getReplay().snapshots);
    expect(replayJournal(second.getJournal())).toEqual(second.getReplay().snapshots);
    first.stop();
    second.stop();
  });

  it('uses the same canonical multi-card order for live logs, journal actions and replay', async () => {
    let submitted: string[] = [];
    const agents: DecisionAgent[] = [0, 1, 2].map((seat) => ({ name: 'Agent ' + seat, kind: 'bot', decide: (state) => {
      if (state.phase === 'calling') return { type: 'call', score: seat === 2 ? 3 : 0 };
      const action = legalBotActions(state).find((candidate) => candidate.type === 'play' && identifyCombination(candidate.cards)?.type === 'triple-pair');
      if (!action || action.type !== 'play') throw new Error('Expected a legal triple with a pair');
      const cards = [...action.cards].sort((left, right) => rankValue(right.rank) - rankValue(left.rank));
      submitted = cards.map((card) => card.id);
      return { type: 'play', cards };
    } }));
    const scheduler = new GameScheduler(agents as [DecisionAgent, DecisionAgent, DecisionAgent], { seed: 7 });
    for (let step = 0; step < 4; step += 1) await scheduler.step();
    const replay = scheduler.getReplay();
    const action = replay.turns.at(-1)!.action;
    expect(action.type).toBe('play');
    expect(replay.turns.at(-1)!.source).toBe('agent');
    if (action.type === 'play') {
      expect(action.cards.map((card) => card.id)).not.toEqual(submitted);
      expect(replay.snapshots.at(-1)!.logs.at(-1)!.cards).toEqual(action.cards);
    }
    expect(replayJournal(JSON.parse(JSON.stringify(scheduler.getJournal())))).toEqual(replay.snapshots);
    scheduler.stop();
  });

  it('starts idle, steps in order, and reproduces the CLI game without changing earlier snapshots', async () => {
    const scheduler = new GameScheduler(createDefaultBots(7), { seed: 7 });
    const initial = scheduler.getReplay();
    expect(initial.session.status).toBe('idle');
    expect(initial.snapshots).toHaveLength(1);
    await scheduler.step();
    expect(scheduler.getReplay().session.status).toBe('paused');
    expect(scheduler.getReplay().snapshots).toHaveLength(2);
    expect(initial.snapshots).toHaveLength(1);
    scheduler.start();
    await vi.runAllTimersAsync();
    const replay = scheduler.getReplay();
    expect(replay.session.status).toBe('finished');
    expect(replay.snapshots).toEqual(runReplayGame(createDefaultBots(7), 7));
    expect(replay.turns).toHaveLength(replay.snapshots.length - 1);
    expect(replayJournal(JSON.parse(JSON.stringify(scheduler.getJournal())))).toEqual(replay.snapshots);
    const count = replay.snapshots.length;
    scheduler.start();
    await scheduler.step();
    expect(scheduler.getReplay().snapshots).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces concurrent steps rather than advancing the same seat twice', async () => {
    const scheduler = new GameScheduler(createDefaultBots(7));
    await Promise.all([scheduler.step(), scheduler.step(), scheduler.step()]);
    expect(scheduler.getReplay().turns).toHaveLength(1);
    scheduler.stop();
  });

  it('does not schedule another turn while an agent is still deciding', async () => {
    let resolveDecision!: (action: BotAction) => void;
    const decide = vi.fn(() => new Promise<BotAction>((resolve) => { resolveDecision = resolve; }));
    const scheduler = new GameScheduler([{ name: 'Slow', decide }, ...createDefaultBots(7).slice(1)] as [DecisionAgent, DecisionAgent, DecisionAgent], { stepIntervalMs: 1, turnTimeoutMs: 100 });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(scheduler.getReplay().turns).toHaveLength(0);
    resolveDecision({ type: 'call', score: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.getReplay().turns).toHaveLength(1);
    scheduler.pause();
    await vi.advanceTimersByTimeAsync(200);
    expect(scheduler.getReplay().turns).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('publishes real decision deadlines without changing snapshots or journal actions', async () => {
    let resolveDecision!: (action: BotAction) => void;
    let agentDeadline = 0;
    const slow: DecisionAgent = { name: 'Slow', decide: (_, context) => {
      agentDeadline = context.deadline;
      return new Promise((resolve) => { resolveDecision = resolve; });
    } };
    const scheduler = new GameScheduler([slow, slow, slow], { turnTimeoutMs: 1200 });
    const events: unknown[] = [];
    scheduler.subscribe(() => events.push(scheduler.getSession().decision));
    expect(scheduler.getSession().decision).toBeNull();
    const pending = scheduler.step();
    await vi.advanceTimersByTimeAsync(0);
    const active = scheduler.getSession();
    expect(active.decision).toEqual({ seat: 0, phase: 'calling', sequence: 1, startedAt: active.serverTime, deadline: active.serverTime + 1200 });
    expect(agentDeadline).toBe(active.decision!.deadline);
    expect(scheduler.getReplay().snapshots).toHaveLength(1);
    active.decision!.seat = 2;
    expect(scheduler.getSession().decision!.seat).toBe(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(scheduler.getSession().decision!.deadline - scheduler.getSession().serverTime).toBe(900);
    resolveDecision({ type: 'call', score: 0 });
    await pending;
    expect(scheduler.getSession().decision).toBeNull();
    expect(scheduler.getJournal().turns).toHaveLength(1);
    expect(scheduler.getJournal()).not.toHaveProperty('decision');
    expect(events[0]).not.toBeNull();
    expect(events.at(-1)).toBeNull();
    scheduler.stop();
  });

  it.each(['pause', 'stop'] as const)('clears decision metadata immediately on %s and ignores the late response', async (action) => {
    let resolveDecision!: (action: BotAction) => void;
    const slow: DecisionAgent = { name: 'Slow', decide: () => new Promise((resolve) => { resolveDecision = resolve; }) };
    const scheduler = new GameScheduler([slow, slow, slow]);
    const pending = scheduler.step();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.getSession().decision).not.toBeNull();
    scheduler[action]();
    expect(scheduler.getSession().decision).toBeNull();
    await pending;
    resolveDecision({ type: 'call', score: 3 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(scheduler.getReplay().turns).toHaveLength(0);
    expect(scheduler.getSession().decision).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels paused decisions and ignores their late responses', async () => {
    let resolveDecision!: (action: BotAction) => void;
    let decisionSignal!: AbortSignal;
    const slow: DecisionAgent = { name: 'Slow', decide: (_, context) => {
      decisionSignal = context.signal;
      return new Promise((resolve) => { resolveDecision = resolve; });
    } };
    const scheduler = new GameScheduler([slow, slow, slow]);
    const pending = scheduler.step();
    await vi.advanceTimersByTimeAsync(0);
    scheduler.pause();
    await pending;
    expect(decisionSignal.aborted).toBe(true);
    resolveDecision({ type: 'call', score: 3 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(scheduler.getReplay().turns).toHaveLength(0);
    expect(scheduler.getReplay().session.status).toBe('paused');
  });

  it.each(['timeout', 'error', 'invalid'] as const)('finishes safely when all agents repeatedly return %s decisions', async (reason) => {
    const broken: DecisionAgent = { name: 'Broken', decide: () => {
      if (reason === 'timeout') return new Promise<BotAction>(() => undefined);
      if (reason === 'error') throw new Error('Agent unavailable');
      return { type: 'play', cards: [] };
    } };
    const scheduler = new GameScheduler([broken, broken, broken], { turnTimeoutMs: 10, stepIntervalMs: 0 });
    scheduler.start();
    await vi.runAllTimersAsync();
    const replay = scheduler.getReplay();
    expect(replay.session.status).toBe('finished');
    expect(replay.turns.every((turn) => turn.source === 'fallback' && turn.reason === reason)).toBe(true);
    expect(replay.snapshots.at(-1)?.winner).toBeDefined();
    expect(replayJournal(scheduler.getJournal())).toEqual(replay.snapshots);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses canonical held cards and isolates state from agent mutation', async () => {
    const malicious: DecisionAgent = { name: 'Mutator', decide: (state) => {
      if (state.phase === 'calling') {
        state.hands[0].splice(0);
        return { type: 'call', score: 3 };
      }
      const held = state.hands[state.currentSeat][0];
      return { type: 'play', cards: [{ ...held, rank: 'big-joker', suit: 'joker', display: 'forged' }] };
    } };
    const scheduler = new GameScheduler([malicious, malicious, malicious]);
    await scheduler.step();
    const held = scheduler.getReplay().snapshots.at(-1)!.hands[0][0];
    expect(scheduler.getReplay().snapshots.at(-1)!.hands[0]).toHaveLength(20);
    await scheduler.step();
    const turn = scheduler.getReplay().turns.at(-1)!;
    expect(turn.action).toEqual({ type: 'play', cards: [held] });
    expect(replayJournal(scheduler.getJournal())).toEqual(scheduler.getReplay().snapshots);
    scheduler.stop();
  });

  it('rejects invalid runtime bid values and falls back to not calling', async () => {
    const invalid: DecisionAgent = { name: 'Invalid bid', decide: () => ({ type: 'call', score: 99 } as unknown as BotAction) };
    const scheduler = new GameScheduler([invalid, invalid, invalid]);
    await scheduler.step();
    expect(scheduler.getReplay().turns[0]).toMatchObject({ reason: 'invalid', action: { type: 'call', score: 0 } });
    scheduler.stop();
  });

  it('stops pending work permanently and rejects shuffled or incomplete journals', async () => {
    const scheduler = new GameScheduler(createDefaultBots(7));
    await scheduler.step();
    const journal = scheduler.getJournal();
    expect(() => replayJournal({ ...journal, turns: [{ ...journal.turns[0], seat: 2 }] })).toThrow(/out of order/);
    expect(() => replayJournal({ ...journal, status: 'finished' })).toThrow(/incomplete/);
    scheduler.start();
    scheduler.stop();
    scheduler.start();
    await scheduler.step();
    await vi.runAllTimersAsync();
    expect(scheduler.getReplay().session.status).toBe('stopped');
    expect(scheduler.getReplay().turns).toHaveLength(1);
  });
});
