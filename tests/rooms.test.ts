import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomManager, type AgentRegistration } from '../server/rooms/room-manager.js';
import { createReplayServer } from '../server/http/replay-server.js';
import { replayJournal } from '../server/rooms/scheduler.js';
import { runBotGame } from '../server/agents/bot-game.js';
import { createDefaultBots, type BotAction } from '../server/agents/bots.js';

const players: AgentRegistration[] = [
  { id: 'agent-0', name: 'Random Bot', kind: 'random', seat: 0 },
  { id: 'agent-1', name: 'Greedy Bot', kind: 'greedy', seat: 1 },
  { id: 'agent-2', name: 'Greedy Bot', kind: 'greedy', seat: 2 },
];

describe('room lifecycle', () => {
  const managers: RoomManager[] = [];
  const make = (options: ConstructorParameters<typeof RoomManager>[0] = {}) => {
    const manager = new RoomManager(options);
    managers.push(manager);
    return manager;
  };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { for (const manager of managers.splice(0)) manager.dispose(); vi.useRealTimers(); });

  it('generates replayable random seeds but retains explicit seeds including zero', async () => {
    const manager = make();
    const random = manager.create({ players });
    expect(Number.isInteger(random.seed)).toBe(true);
    expect(random.seed).toBeGreaterThanOrEqual(0);
    expect(random.seed).toBeLessThanOrEqual(0xffffffff);
    expect(replayJournal(manager.getJournal(random.id))).toEqual(manager.getReplay(random.id).snapshots);
    const first = manager.create({ seed: 0, players });
    const second = manager.create({ seed: 0, players });
    expect(first.seed).toBe(0);
    expect(manager.getReplay(first.id).snapshots).toEqual(manager.getReplay(second.id).snapshots);
  });

  it('randomizes every new generation and legacy reset without changing seats, scores or other rooms', async () => {
    const manager = make({ baseScore: 5, stepIntervalMs: 0 });
    const room = manager.create({ seed: 7, players });
    const untouched = manager.create({ seed: 21, players: players.map((player) => ({ ...player, id: 'other-' + player.id })) });
    await manager.control(room.id, 'start');
    await vi.advanceTimersByTimeAsync(1000);
    const completed = manager.getReplay(room.id);
    expect(completed.accounting?.status).toBe('recorded');
    const next = await manager.control(room.id, 'new-game');
    expect(next.seed).not.toBe(7);
    expect(next.room.seed).toBe(next.seed);
    expect(next.generation).toBe(room.generation + 1);
    expect(next.room.players).toEqual(completed.room.players);
    expect(next.room.baseScore).toBe(5);
    expect(next.session.status).toBe('idle');
    expect(next.turns).toHaveLength(0);
    expect(next.accounting).toBeNull();
    expect(replayJournal(manager.getJournal(room.id))).toEqual(next.snapshots);
    expect(manager.getGameRecord(completed.accounting!.gameId).seed).toBe(7);
    expect(manager.getRoomGames(room.id).total).toBe(1);
    expect(manager.get(untouched.id)).toEqual(untouched);
    const reset = await manager.control(room.id, 'reset');
    expect(reset.seed).not.toBe(next.seed);
    expect(reset.snapshots).not.toEqual(next.snapshots);
    expect(replayJournal(manager.getJournal(room.id))).toEqual(reset.snapshots);
    expect(reset.generation).toBe(next.generation + 1);
  });

  it('cancels late responses when switching to a random new game', async () => {
    let resolveDecision!: (action: BotAction) => void;
    let signal!: AbortSignal;
    const manager = make({ agentFactory: (player) => ({ name: player.name, kind: 'bot', decide: (_, context) => {
      signal = context.signal;
      return new Promise((resolve) => { resolveDecision = resolve; });
    } }) });
    const room = manager.create({ seed: 7, players });
    const pending = manager.control(room.id, 'step');
    await vi.advanceTimersByTimeAsync(0);
    const next = await manager.control(room.id, 'new-game');
    expect(signal.aborted).toBe(true);
    resolveDecision({ type: 'call', score: 3 });
    await pending;
    expect(next.seed).not.toBe(7);
    expect(manager.getReplay(room.id).turns).toHaveLength(0);
    expect(manager.getReplay(room.id).session.status).toBe('idle');
  });

  it('creates an empty waiting room and assigns three independent seats before dealing', async () => {
    const manager = make();
    const room = manager.create({ seed: 7 });
    expect(room.id).toMatch(/^room_[a-f0-9]{12}$/);
    expect(room.viewUrl).toBe('/rooms/' + room.id);
    expect(room.status).toBe('waiting');
    expect(manager.getReplay(room.id).snapshots).toHaveLength(0);
    await expect(manager.control(room.id, 'start')).rejects.toMatchObject({ statusCode: 409 });
    manager.join(room.id, players[2]);
    manager.join(room.id, players[0]);
    manager.join(room.id, players[1]);
    expect(manager.get(room.id)).toMatchObject({ status: 'ready', capacity: 3 });
    expect(manager.get(room.id).players.map((player) => player.seat)).toEqual([0, 1, 2]);
    expect(manager.getReplay(room.id).snapshots[0].hands.map((hand) => hand.length)).toEqual([17, 17, 17]);
  });

  it('supports idempotent registration but rejects duplicate seats, conflicting agents, and a fourth player', () => {
    const manager = make();
    const room = manager.create();
    manager.join(room.id, players[0]);
    expect(manager.join(room.id, players[0]).players).toHaveLength(1);
    expect(() => manager.join(room.id, { ...players[0], name: 'Changed' })).toThrow(/conflict/);
    expect(() => manager.join(room.id, { ...players[1], seat: 0 })).toThrow(/occupied/);
    manager.join(room.id, players[1]);
    manager.join(room.id, players[2]);
    expect(() => manager.join(room.id, { name: 'Fourth', kind: 'greedy' })).toThrow(/full/);
    expect(manager.join(room.id, players[0]).players).toHaveLength(3);
  });

  it('rejects malformed registrations and rolls back failed room creation', () => {
    const manager = make({ maxRooms: 1 });
    expect(() => manager.create({ players: [...players, players[0]] })).toThrow(/three seats/);
    expect(() => manager.create({ players: [players[0], { ...players[1], seat: 0 }] })).toThrow(/occupied/);
    expect(() => manager.create({ seed: -1 })).toThrow(/seed/);
    const room = manager.create();
    expect(() => manager.join(room.id, { name: ' ', kind: 'random' })).toThrow(/name/);
    expect(() => manager.join(room.id, { name: 'Remote', kind: 'http' })).toThrow(/URL/);
    expect(() => manager.join(room.id, { ...players[0], seat: 3 })).toThrow(/seat/);
    expect(manager.get(room.id).players).toHaveLength(0);
  });

  it('runs an entire room game, exports a verifiable journal, and resets only that room', async () => {
    const manager = make({ stepIntervalMs: 0 });
    const first = manager.create({ seed: 7, players });
    const second = manager.create({ seed: 21, players });
    await manager.control(first.id, 'start');
    await vi.advanceTimersByTimeAsync(1000);
    expect(manager.get(first.id).status).toBe('finished');
    const replay = manager.getReplay(first.id);
    expect(replayJournal(manager.getJournal(first.id))).toEqual(replay.snapshots);
    expect(replay.snapshots.at(-1)?.logs).toEqual(runBotGame(createDefaultBots(7), 7).state.logs);
    expect(manager.getReplay(second.id).snapshots).toHaveLength(1);
    expect(manager.get(second.id).status).toBe('ready');
    await manager.control(first.id, 'reset');
    expect(manager.get(first.id).generation).toBeGreaterThan(first.generation);
    expect(manager.getReplay(first.id).turns).toHaveLength(0);
    expect(manager.get(second.id).generation).toBe(second.generation);
  });

  it('allows a pre-game departure and refills the vacant seat without stale game state', () => {
    const manager = make();
    const room = manager.create({ players });
    expect(manager.leave(room.id, 'agent-1').status).toBe('waiting');
    expect(manager.getReplay(room.id).snapshots).toHaveLength(0);
    const ready = manager.join(room.id, { id: 'replacement', name: 'Replacement', kind: 'greedy' });
    expect(ready.status).toBe('ready');
    expect(ready.players[1]).toMatchObject({ id: 'replacement', seat: 1 });
    expect(manager.getReplay(room.id).snapshots[0].players[1]).toBe('Replacement');
  });

  it('closes a live room on agent departure, aborts the pending decision, and preserves its partial journal', async () => {
    let signal!: AbortSignal;
    let resolveDecision!: (action: BotAction) => void;
    const manager = make({ agentFactory: (player) => ({ name: player.name, decide: (_, context) => {
      signal = context.signal;
      return new Promise((resolve) => { resolveDecision = resolve; });
    } }) });
    const room = manager.create({ players });
    const step = manager.control(room.id, 'step');
    await vi.advanceTimersByTimeAsync(0);
    const closed = manager.leave(room.id, 'agent-0');
    expect(closed).toMatchObject({ status: 'closed', closeReason: 'agent-left' });
    expect(signal.aborted).toBe(true);
    resolveDecision({ type: 'call', score: 3 });
    await step;
    expect(manager.getJournal(room.id).turns).toHaveLength(0);
    await expect(manager.control(room.id, 'start')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('retains observed rooms, gives disconnected spectators a grace period, and expires abandoned rooms', () => {
    let now = 0;
    const manager = make({ now: () => now, idleTimeoutMs: 100, closedRetentionMs: 50 });
    const room = manager.create();
    const unwatch = manager.watch(room.id, () => undefined);
    now = 200;
    manager.sweep();
    expect(manager.get(room.id)).toMatchObject({ status: 'waiting', spectators: 1 });
    unwatch();
    expect(manager.get(room.id).spectators).toBe(0);
    now = 299;
    manager.sweep();
    expect(manager.get(room.id).status).toBe('waiting');
    now = 300;
    manager.sweep();
    expect(manager.get(room.id)).toMatchObject({ status: 'closed', closeReason: 'expired' });
    now = 350;
    manager.sweep();
    expect(() => manager.get(room.id)).toThrow(/not found/);
  });

  it('enforces room limits, notifies closure once, and releases all timers on shutdown', () => {
    let now = 0;
    const manager = make({ maxRooms: 1, closedRetentionMs: 50, now: () => now });
    const room = manager.create();
    const notices: string[] = [];
    manager.watch(room.id, () => notices.push(manager.get(room.id).status));
    manager.close(room.id);
    manager.close(room.id);
    expect(notices.filter((status) => status === 'closed')).toHaveLength(1);
    expect(() => manager.create()).toThrow(/limit/);
    now = 50;
    const next = manager.create();
    expect(next.id).not.toBe(room.id);
    manager.dispose();
    expect(() => manager.create()).toThrow(/stopped/);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('room HTTP API', () => {
  it('deals different actual hands for consecutive seedless Bot and model room creations without model calls', async () => {
    let calls = 0;
    const server = createReplayServer({ deepseek: { apiKey: 'test-only-key', transport: async () => { calls += 1; throw new Error('Should not be called'); } } });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const hands = new Set<string>();
    try {
      for (const kind of ['random', 'deepseek', 'random', 'deepseek', 'random', 'deepseek']) {
        const created = await fetch(origin + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ players: [0, 1, 2].map((seat) => ({ name: 'Agent ' + seat, kind, seat })) }) });
        expect(created.status).toBe(201);
        const room = await created.json();
        const replay = await (await fetch(origin + '/api/rooms/' + room.id + '/replay')).json();
        hands.add(JSON.stringify(replay.snapshots[0].hands));
        expect(replay.turns).toHaveLength(0);
        const journal = await (await fetch(origin + '/api/rooms/' + room.id + '/journal')).json();
        expect(replayJournal(journal)).toEqual(replay.snapshots);
      }
      expect(hands.size).toBe(6);
      expect(calls).toBe(0);
    } finally { await new Promise<void>((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections(); }); }
  });

  it('does not create or invoke a game when visiting the homepage or querying configuration', async () => {
    let calls = 0;
    const server = createReplayServer({ maxRooms: 1, baseScore: 5, deepseek: { apiKey: 'test-only-key', transport: async () => { calls += 1; throw new Error('Should not be called'); } } });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    try {
      for (const path of ['/', '/index.html']) expect((await fetch(origin + path)).status).toBe(200);
      expect(await (await fetch(origin + '/api/config')).json()).toEqual({ baseScore: 5, capabilities: { randomDeals: true, modelResponses: true, humanPlayers: true } });
      expect((await fetch(origin + '/api/providers/deepseek')).status).toBe(200);
      for (const resource of ['replay', 'events', 'control', 'journal']) expect((await fetch(origin + '/api/' + resource)).status).toBe(404);
      const created = await fetch(origin + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(created.status).toBe(201);
      const room = await created.json();
      expect(room.status).toBe('waiting');
      const replay = await (await fetch(origin + '/api/rooms/' + room.id + '/replay')).json();
      expect(replay.snapshots).toHaveLength(0);
      expect(replay.turns).toHaveLength(0);
      expect(calls).toBe(0);
    } finally { await new Promise<void>((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections(); }); }
  });
  it('creates, joins, queries, controls, isolates streams, and closes room resources', async () => {
    const server = createReplayServer({ stepIntervalMs: 0 });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const request = async (path: string, body: unknown, method = 'POST', expected = 200) => {
      const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(expected);
      return response.json();
    };
    let closed = false;
    try {
      const room = await request('/api/rooms', { seed: 7 }, 'POST', 201);
      const base = '/api/rooms/' + room.id;
      expect(room.status).toBe('waiting');
      expect((await fetch(origin + room.viewUrl)).status).toBe(200);
      await request(base + '/control', { action: 'start' }, 'POST', 409);
      for (const player of players) await request(base + '/players', player);
      const ready = await (await fetch(origin + base)).json();
      expect(ready.status).toBe('ready');
      await request(base + '/players', { name: 'Fourth', kind: 'greedy' }, 'POST', 409);
      const other = await request('/api/rooms', { players }, 'POST', 201);
      const events = await fetch(origin + base + '/events');
      const reader = events.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(room.id);
      await request(base + '/control', { action: 'step' });
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('"index":1');
      expect((await (await fetch(origin + '/api/rooms/' + other.id + '/replay')).json()).snapshots).toHaveLength(1);
      await request(base + '/players/agent-0', {}, 'DELETE');
      const ending = new TextDecoder().decode((await reader.read()).value);
      expect(ending).toContain('"status":"closed"');
      expect((await reader.read()).done).toBe(true);
      expect((await (await fetch(origin + base)).json()).closeReason).toBe('agent-left');
      expect((await (await fetch(origin + base + '/journal')).json()).roomId).toBe(room.id);
      await request(base + '/control', { action: 'reset' }, 'POST', 409);
      expect((await fetch(origin + '/api/rooms/missing')).status).toBe(404);
      expect((await fetch(origin + '/rooms/missing')).status).toBe(404);
      await request('/api/rooms', { seed: 7, players: [players[0], players[0], players[0]] }, 'POST', 400);
      await request('/api/rooms', { name: 'x'.repeat(5000) }, 'POST', 413);
      const watched = await fetch(origin + '/api/rooms/' + other.id + '/events');
      const watchedReader = watched.body!.getReader();
      await watchedReader.read();
      await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
      closed = true;
      while (!(await watchedReader.read()).done) {}
    } finally {
      if (!closed) await new Promise<void>((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections(); });
    }
  });
});
