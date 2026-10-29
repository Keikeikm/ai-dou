import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { RoomManager } from '../server/rooms/room-manager.js';
import { GameScheduler, replayJournal, type DecisionAgent } from '../server/rooms/scheduler.js';
import { legalBotActions } from '../server/agents/bots.js';
import { parseHumanAction } from '../server/agents/human.js';
import { createGame } from '../server/game/game.js';
import { applyGameAction } from '../server/game/actions.js';
import { createReplayServer } from '../server/http/replay-server.js';

const managers: RoomManager[] = [];
const schedulers: GameScheduler[] = [];
afterEach(() => { for (const scheduler of schedulers.splice(0)) scheduler.stop(); for (const manager of managers.splice(0)) manager.dispose(); vi.useRealTimers(); });
function setup(humanSeat = 0, humanTurnTimeoutMs = 60000) {
  const manager = new RoomManager({ stepIntervalMs: 0, humanTurnTimeoutMs });
  managers.push(manager);
  const room = manager.create({ seed: 7, players: [0, 1, 2].map((seat) => ({ id: 'player_' + seat, name: 'Player ' + seat, kind: seat === humanSeat ? 'human' : 'greedy', seat })) });
  return { manager, room, token: room.humanControl!.token };
}
function submission(manager: RoomManager, id: string, action: unknown) {
  const replay = manager.getReplay(id);
  return { generation: replay.generation, decisionId: replay.session.decision!.id!, action };
}
function stateFor(manager: RoomManager, id: string) {
  const journal = manager.getJournal(id);
  let state = createGame(journal.seed);
  for (const turn of journal.turns) state = applyGameAction(state, turn.seat, turn.action);
  return state;
}

describe('human player rooms', () => {
  it('returns a private grant only on first registration and never in shared room data', () => {
    const { manager, room, token } = setup();
    expect(room.humanControl).toMatchObject({ playerId: 'player_0', seat: 0 });
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify([manager.get(room.id), manager.getReplay(room.id), manager.getJournal(room.id)])).not.toContain(token);
    expect(manager.join(room.id, { id: 'player_0', name: 'Player 0', kind: 'human', seat: 0 })).not.toHaveProperty('humanControl');
    expect(() => manager.create({ players: [{ name: 'First', kind: 'human' }, { name: 'Second', kind: 'human' }] })).toThrow(/一位真人/);
    expect(() => manager.create({ players: [{ name: 'Human', kind: 'human', api_key: 'not-allowed' }] })).toThrow(/credentials/);
  });

  it('arms a human decision without waiting for HTTP completion or invoking any Agent', async () => {
    const { manager, room } = setup();
    const replay = await manager.control(room.id, 'step');
    expect(replay.turns).toHaveLength(0);
    expect(replay.session.decision).toMatchObject({ kind: 'human', sequence: 1, seat: 0, phase: 'calling' });
    expect(replay.session.decision!.deadline - replay.session.decision!.startedAt).toBe(60000);
    const id = replay.session.decision!.id;
    await manager.control(room.id, 'step');
    expect(manager.getReplay(room.id).session.decision!.id).toBe(id);
  });

  it('rejects missing, foreign and wrong tokens, stale generations and duplicate submissions', async () => {
    const { manager, room, token } = setup();
    const foreign = manager.create({ players: [{ name: 'Other', kind: 'human' }] });
    await manager.control(room.id, 'step');
    const input = submission(manager, room.id, { type: 'call', score: 0 });
    for (const invalid of [undefined, 'bad', foreign.humanControl!.token]) expect(() => manager.submitHumanAction(room.id, invalid, input)).toThrow(/权限/);
    expect(() => manager.submitHumanAction(room.id, token, { ...input, generation: 99 })).toThrow(/变化/);
    expect(manager.getJournal(room.id).turns).toHaveLength(0);
    const accepted = manager.submitHumanAction(room.id, token, input);
    expect(accepted.turns[0]).toMatchObject({ source: 'human', decisionKind: 'human', action: { type: 'call', score: 0 } });
    expect(() => manager.submitHumanAction(room.id, token, input)).toThrow(/过期/);
    expect(manager.getJournal(room.id).turns).toHaveLength(1);
  });

  it('keeps invalid selections editable and accepts real multi-card actions from the held hand', async () => {
    const { manager, room, token } = setup();
    await manager.control(room.id, 'step');
    manager.submitHumanAction(room.id, token, submission(manager, room.id, { type: 'call', score: 3 }));
    await manager.control(room.id, 'step');
    const waiting = manager.getReplay(room.id);
    const card = waiting.snapshots.at(-1)!.hands[0][0];
    for (const action of [{ type: 'pass' }, { type: 'call', score: 0 }, { type: 'play', cards: [card.id, card.id] },
      { type: 'play', cards: [waiting.snapshots.at(-1)!.hands[1][0].id] }]) {
      expect(() => manager.submitHumanAction(room.id, token, submission(manager, room.id, action))).toThrow();
      expect(manager.getReplay(room.id).session.decision!.id).toBe(waiting.session.decision!.id);
      expect(manager.getJournal(room.id).turns).toHaveLength(1);
    }
    const pair = legalBotActions(stateFor(manager, room.id)).find((action) => action.type === 'play' && action.cards.length === 2)!;
    expect(pair.type).toBe('play');
    const result = manager.submitHumanAction(room.id, token, submission(manager, room.id, { type: 'play', cards: pair.type === 'play' ? pair.cards.map((held) => held.id) : [] }));
    expect(result.turns[1]).toMatchObject({ source: 'human', decisionKind: 'human', action: { type: 'play' } });
    expect(result.snapshots.at(-1)!.hands[0]).toHaveLength(waiting.snapshots.at(-1)!.hands[0].length - 2);
  });

  it('invalidates old decision IDs on pause and new games, while retaining the private seat grant', async () => {
    vi.useFakeTimers();
    const { manager, room, token } = setup(0, 100);
    await manager.control(room.id, 'step');
    const old = submission(manager, room.id, { type: 'call', score: 0 });
    await manager.control(room.id, 'pause');
    expect(manager.getReplay(room.id).session.decision).toBeNull();
    vi.advanceTimersByTime(101);
    expect(manager.getJournal(room.id).turns).toHaveLength(0);
    await manager.control(room.id, 'step');
    expect(() => manager.submitHumanAction(room.id, token, old)).toThrow(/过期/);
    const next = await manager.control(room.id, 'new-game');
    vi.advanceTimersByTime(101);
    expect(manager.getJournal(room.id).turns).toHaveLength(0);
    expect(() => manager.submitHumanAction(room.id, token, old)).toThrow(/变化/);
    expect(JSON.stringify(next)).not.toContain(token);
    await manager.control(room.id, 'step');
    expect(() => manager.submitHumanAction(room.id, token, submission(manager, room.id, { type: 'call', score: 0 }))).not.toThrow();
  });

  it('records timeout as human-seat system fallback rather than a fabricated human move', async () => {
    vi.useFakeTimers();
    const { manager, room, token } = setup(0, 100);
    await manager.control(room.id, 'step');
    const old = submission(manager, room.id, { type: 'call', score: 0 });
    vi.advanceTimersByTime(100);
    expect(manager.getJournal(room.id).turns[0]).toMatchObject({ source: 'fallback', decisionKind: 'human', reason: 'timeout', action: { type: 'call', score: 0 } });
    expect(() => manager.submitHumanAction(room.id, token, old)).toThrow(/过期/);
  });

  it('automatically resumes AI turns after a human submission without ever calling the human marker', async () => {
    vi.useFakeTimers();
    const humanDecide = vi.fn(() => ({ type: 'call' as const, score: 0 as const }));
    const aiDecide = vi.fn(() => ({ type: 'call' as const, score: 0 as const }));
    const agents: [DecisionAgent, DecisionAgent, DecisionAgent] = [{ name: 'Human', kind: 'human', decide: humanDecide },
      { name: 'AI 1', kind: 'bot', decide: aiDecide }, { name: 'AI 2', kind: 'bot', decide: aiDecide }];
    const scheduler = new GameScheduler(agents, { seed: 7, stepIntervalMs: 10 });
    schedulers.push(scheduler);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.getSession().decision).toMatchObject({ kind: 'human' });
    expect(aiDecide).not.toHaveBeenCalled();
    scheduler.submitHumanAction(0, scheduler.getSession().decision!.id!, { type: 'call', score: 0 });
    await vi.advanceTimersByTimeAsync(10);
    expect(scheduler.getJournal().turns).toHaveLength(2);
    expect(aiDecide).toHaveBeenCalledOnce();
    expect(humanDecide).not.toHaveBeenCalled();
  });

  it('completes and archives a one-human two-model game with model input isolation and no replay calls', async () => {
    let id = '';
    let requests = 0;
    const manager = new RoomManager({ stepIntervalMs: 0, deepseek: { apiKey: 'test-only-key', transport: async (_credentials, request) => {
      requests += 1;
      const payload = JSON.parse(request.messages[1].content);
      const current = manager.getReplay(id).snapshots.at(-1)!;
      expect(payload.game.seat).not.toBe(1);
      const publicBottom = new Set(payload.game.bottom_cards);
      for (const [seat, hand] of current.hands.entries()) if (seat !== payload.game.seat) for (const card of hand) {
        if (!publicBottom.has(card.id)) expect(request.messages[1].content).not.toContain(card.id);
      }
      const choice = payload.action_options.find((action: { action: string }) => action.action === 'call_3')
        ?? payload.action_options.find((action: { action: string }) => action.action === 'play') ?? payload.action_options[0];
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ action_index: choice.index }) } }] };
    } } });
    managers.push(manager);
    const room = manager.create({ seed: 7, players: [0, 1, 2].map((seat) => ({ name: 'Player ' + seat, kind: seat === 1 ? 'human' : 'deepseek', seat })) });
    id = room.id;
    for (let step = 0; step < 500 && manager.get(id).status !== 'finished'; step += 1) {
      const replay = await manager.control(id, 'step');
      if (replay.session.decision?.kind === 'human') {
        const choices = legalBotActions(stateFor(manager, id));
        const chosen = choices.find((action) => action.type === 'call' && action.score === 3) ?? choices.find((action) => action.type === 'play') ?? choices[0];
        const action = chosen.type === 'play' ? { type: 'play', cards: chosen.cards.map((card) => card.id) } : chosen;
        manager.submitHumanAction(id, room.humanControl!.token, submission(manager, id, action));
      }
    }
    expect(manager.get(id).status).toBe('finished');
    const record = manager.getGameRecord(room.gameId);
    expect(record.journal.turns.some((turn) => turn.source === 'human')).toBe(true);
    expect(record.journal.turns.filter((turn) => turn.decisionKind === 'human').every((turn) => !turn.modelResponse)).toBe(true);
    expect(record.journal.turns.filter((turn) => turn.decisionKind === 'model')).toHaveLength(requests);
    const before = requests;
    expect(replayJournal(record.journal)).toEqual(manager.getReplay(id).snapshots);
    expect(requests).toBe(before);
    expect(JSON.stringify(record)).not.toContain(room.humanControl!.token);
  });

  it('rejects malformed card and call submissions before changing the hand', () => {
    const hand = createGame(7).hands[0];
    for (const action of [null, [], { type: 'call', score: '3' }, { type: 'call', score: 4 }, { type: 'play', cards: [] },
      { type: 'play', cards: [hand[0].id], extra: true }, { type: 'pass', cards: [] }]) expect(() => parseHumanAction(action, hand)).toThrow();
    expect(() => new GameScheduler([{ name: 'Human', kind: 'human', decide: () => ({ type: 'pass' }) }, { name: 'Bot', decide: () => ({ type: 'pass' }) }, { name: 'Bot', decide: () => ({ type: 'pass' }) }], { humanTurnTimeoutMs: 0 })).toThrow(/timeout/);
  });
});

describe('human action HTTP API', () => {
  it('requires same-origin POST, private authorization and current decision identity', async () => {
    const server = createReplayServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const post = (pathname: string, body: unknown, headers: Record<string, string> = {}) => fetch(origin + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    try {
      expect(await (await fetch(origin + '/human-play')).text()).toContain('真人与 AI 对战');
      const room = await (await post('/api/rooms', { players: [{ name: 'Me', kind: 'human', seat: 0 }, { name: 'Bot 1', kind: 'greedy', seat: 1 }, { name: 'Bot 2', kind: 'greedy', seat: 2 }] })).json();
      const waiting = await (await post('/api/rooms/' + room.id + '/control', { action: 'step' })).json();
      const input = { generation: waiting.generation, decisionId: waiting.session.decision.id, action: { type: 'call', score: 0 } };
      const endpoint = '/api/rooms/' + room.id + '/human-action';
      expect((await fetch(origin + endpoint)).status).toBe(405);
      expect((await post(endpoint, input)).status).toBe(403);
      expect((await post(endpoint, input, { Authorization: 'Bearer ' + room.humanControl.token, Origin: 'https://foreign.example' })).status).toBe(403);
      const accepted = await post(endpoint, input, { Authorization: 'Bearer ' + room.humanControl.token, Origin: origin });
      expect(accepted.status).toBe(200);
      expect((await accepted.json()).turns[0]).toMatchObject({ source: 'human' });
      expect((await post(endpoint, input, { Authorization: 'Bearer ' + room.humanControl.token })).status).toBe(409);
      for (const pathname of ['', '/replay', '/journal']) expect(await (await fetch(origin + '/api/rooms/' + room.id + pathname)).text()).not.toContain(room.humanControl.token);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
