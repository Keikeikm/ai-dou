import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createDeck, type Card } from '../server/game/cards.js';
import * as game from '../server/blackjack/game.js';
import { BlackjackRooms } from '../server/blackjack/rooms.js';
import { DataStore } from '../server/data/store.js';
import { AgentHttpError } from '../server/agents/http.js';
import type { DeepSeekTransport } from '../server/agents/deepseek.js';
import { createReplayServer } from '../server/http/replay-server.js';
import { BLACKJACK_RULES_VERSION, type BlackjackObservation, type BlackjackRoomGrant } from '../shared/blackjack.js';

const { createBlackjackGame, handValue, applyBlackjackAction, observeBlackjack } = game;
const managers: BlackjackRooms[] = [];
const stores: DataStore[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.dispose(); for (const store of stores.splice(0)) store.close(); vi.restoreAllMocks(); vi.useRealTimers(); });
function ordered(...ranks: string[]): Card[] {
  const rest = createDeck().filter((card) => card.suit !== 'joker');
  const front = ranks.map((rank) => { const index = rest.findIndex((card) => card.rank === rank); if (index < 0) throw new Error('No card: ' + rank); return rest.splice(index, 1)[0]; });
  return [...front, ...rest];
}
const completion = (action: unknown) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(action) } }] });
const stand: DeepSeekTransport = async () => completion({ type: 'stand' });
function setup(ranks = ['8', '9', '7', '7'], transport: DeepSeekTransport = stand, data?: DataStore, timeout = 15000) {
  vi.spyOn(game, 'createBlackjackGame').mockImplementation(() => createBlackjackGame(ordered(...ranks)));
  const manager = new BlackjackRooms({ apiKey: 'test-key', transport }, timeout, data); managers.push(manager);
  const grant = manager.create({});
  const get = () => manager.get(grant.room.id, grant.token);
  const send = (input: Record<string, unknown>) => { const view = get(); return manager.control(view.id, grant.token, { ...input, revision: view.revision, generation: view.generation }); };
  return { manager, grant, get, send };
}

describe('blackjack duel engine', () => {
  it('deals one complete shuffled 52-card deck and rejects invalid deck inputs', () => {
    const state = createBlackjackGame();
    expect(state.hands.map((hand) => hand.length)).toEqual([2, 2]);
    expect(new Set([...state.hands.flat(), ...state.deck].map((card) => card.id)).size).toBe(52);
    expect([...state.hands.flat(), ...state.deck].some((card) => card.suit === 'joker')).toBe(false);
    expect(() => createBlackjackGame(createDeck())).toThrow();
    const duplicate = ordered(); duplicate[0] = duplicate[1];
    expect(() => createBlackjackGame(duplicate)).toThrow();
    expect(() => createBlackjackGame([])).toThrow();
  });
  it.each([
    [['A', 'A', '9'], 21, true, false, false],
    [['A', 'A', '9', 'K'], 21, false, false, false],
    [['A', 'K'], 21, true, true, false],
    [['J', 'Q', '2'], 22, false, false, true],
    [['A', '6'], 17, true, false, false],
  ] as const)('scores %s with flexible aces', (ranks, total, soft, blackjack, bust) => {
    expect(handValue(ordered(...ranks).slice(0, ranks.length))).toEqual({ total, soft, blackjack, bust });
  });
  it.each([
    [['A', '7', 'K', '8'], 'win', 0, 'player-blackjack'],
    [['7', 'A', '8', 'K'], 'loss', 1, 'opponent-blackjack'],
    [['A', 'A', 'K', 'Q'], 'push', null, 'both-blackjack'],
  ] as const)('settles initial naturals without a decision %s', (ranks, result, winner, reason) => {
    const state = createBlackjackGame(ordered(...ranks));
    expect(state).toMatchObject({ phase: 'finished', result, winner, reason, revision: 0, history: [] });
    expect(observeBlackjack(state).opponent.every(Boolean)).toBe(true);
    expect(() => applyBlackjackAction(state, 0, { type: 'hit' })).toThrow('本局已经结束');
  });
  it('alternates free choices and allows the AI to hit on 17', () => {
    const state = createBlackjackGame(ordered('6', '10', '5', '7', '2', '3'));
    applyBlackjackAction(state, 0, { type: 'hit' }); expect(state.turn).toBe(1);
    applyBlackjackAction(state, 1, { type: 'hit' });
    expect(handValue(state.hands[1]).total).toBe(20); expect(state.turn).toBe(0);
    expect(state.revision).toBe(2);
  });
  it.each([0, 1] as const)('skips seat %s after it stands and continues the other seat', (seat) => {
    const state = createBlackjackGame(ordered('4', '5', '4', '5', '2', '3', '2'));
    if (seat === 1) applyBlackjackAction(state, 0, { type: 'hit' });
    applyBlackjackAction(state, seat, { type: 'stand' });
    const other = seat === 0 ? 1 : 0;
    applyBlackjackAction(state, other, { type: 'hit' });
    expect(state.turn).toBe(other); expect(state.stood[seat]).toBe(true);
    expect(() => applyBlackjackAction(state, seat, { type: 'hit' })).toThrow();
    applyBlackjackAction(state, other, { type: 'stand' }); expect(state.phase).toBe('finished');
  });
  it.each([
    [['10', '8', '8', '8'], 'win', 0],
    [['8', '10', '8', '8'], 'loss', 1],
    [['10', '9', '8', '9'], 'push', null],
  ] as const)('compares both stopped hands %s', (ranks, result, winner) => {
    const state = createBlackjackGame(ordered(...ranks));
    applyBlackjackAction(state, 0, { type: 'stand' }); applyBlackjackAction(state, 1, { type: 'stand' });
    expect(state).toMatchObject({ phase: 'finished', result, winner, reason: result === 'push' ? 'equal-total' : 'higher-total' });
  });
  it('automatically stands on drawn 21 but permits a matching drawn 21 push', () => {
    const state = createBlackjackGame(ordered('10', '9', '8', '8', '3', '4'));
    applyBlackjackAction(state, 0, { type: 'hit' });
    expect(state.stood).toEqual([true, false]); expect(state.phase).toBe('play');
    expect(handValue(state.hands[0]).blackjack).toBe(false);
    applyBlackjackAction(state, 1, { type: 'hit' });
    expect(state).toMatchObject({ phase: 'finished', result: 'push' });
  });
  it.each([0, 1] as const)('ends immediately when seat %s busts', (seat) => {
    const state = createBlackjackGame(ordered('10', '9', '8', '8', 'K'));
    if (seat === 1) applyBlackjackAction(state, 0, { type: 'stand' });
    applyBlackjackAction(state, seat, { type: 'hit' });
    expect(state).toMatchObject({ phase: 'finished', winner: seat === 0 ? 1 : 0, reason: seat === 0 ? 'player-bust' : 'opponent-bust' });
    expect(() => applyBlackjackAction(state, seat === 0 ? 1 : 0, { type: 'hit' })).toThrow();
  });
  it('rejects illegal actions atomically', () => {
    const state = createBlackjackGame(ordered('8', '9', '7', '7')); const before = structuredClone(state);
    for (const input of [null, [], { type: 'double' }, { type: 'hit', card: 'spades-A' }, { type: 'stand', extra: true }]) {
      expect(() => applyBlackjackAction(state, 0, input)).toThrow(); expect(state).toEqual(before);
    }
    expect(() => applyBlackjackAction(state, 1, { type: 'stand' })).toThrow(); expect(state).toEqual(before);
  });
  it('keeps opponent holes, drawn cards and deck private in both player observations', () => {
    const state = createBlackjackGame(ordered('4', '5', '4', '5', '2', '3'));
    applyBlackjackAction(state, 0, { type: 'hit' }); applyBlackjackAction(state, 1, { type: 'hit' });
    for (const seat of [0, 1] as const) {
      const view = observeBlackjack(state, seat); const other = seat === 0 ? 1 : 0;
      expect(view.opponent).toEqual([state.hands[other][0], null, null]); expect(view.opponentValue).toBeNull();
      for (const card of [...state.hands[other].slice(1), ...state.deck]) expect(JSON.stringify(view)).not.toContain(card.id);
      expect(view.history.find((event) => event.seat === other)).not.toHaveProperty('card');
      view.hand.pop(); expect(state.hands[seat]).toHaveLength(3);
    }
    applyBlackjackAction(state, 0, { type: 'stand' }); applyBlackjackAction(state, 1, { type: 'stand' });
    expect(observeBlackjack(state).opponent).toEqual(state.hands[1]);
  });
});

describe('blackjack rooms and model decisions', () => {
  it('requires a usable key and never leaks it in the view', () => {
    const empty = new BlackjackRooms(); managers.push(empty);
    expect(() => empty.create({})).toThrow('API key'); expect(() => empty.create({ apiKey: 'has space' })).toThrow();
    const { grant } = setup(); expect(JSON.stringify(grant.room)).not.toContain('test-key');
  });
  it('sends only the AI private observation, alternates and never applies a duplicate command', async () => {
    const transport = vi.fn<DeepSeekTransport>(async (_credentials, request) => {
      const view = JSON.parse(request.messages[1].content) as BlackjackObservation;
      expect(view.seat).toBe(1); expect(view.hand.map((card) => card.rank)).toEqual(['9', '7']);
      expect(view.opponent).toEqual([expect.objectContaining({ rank: '8' }), null, null]);
      expect(view.opponentValue).toBeNull(); expect(view.history[0]).not.toHaveProperty('card');
      return completion({ type: 'stand' });
    });
    const ctx = setup(['8', '9', '7', '7', '2'], transport);
    const before = ctx.get();
    ctx.send({ action: { type: 'hit' } }); expect(ctx.get().thinking).toBe(true);
    expect(() => ctx.manager.control(before.id, ctx.grant.token, { revision: before.revision, generation: before.generation, action: { type: 'hit' } })).toThrow('牌局已更新');
    await vi.waitFor(() => expect(ctx.get().thinking).toBe(false));
    expect(transport).toHaveBeenCalledTimes(1); expect(ctx.get()).toMatchObject({ turn: 0, stood: [false, true], phase: 'play', revision: 2 });
    ctx.send({ action: { type: 'stand' } }); expect(ctx.get().result).toBe('win');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('allows repeated genuine model decisions after the human stops', async () => {
    const transport = vi.fn<DeepSeekTransport>().mockResolvedValueOnce(completion({ type: 'hit' })).mockResolvedValueOnce(completion({ type: 'hit' })).mockResolvedValueOnce(completion({ type: 'stand' }));
    const ctx = setup(['8', '3', '7', '4', '2', '2'], transport);
    ctx.send({ action: { type: 'stand' } });
    await vi.waitFor(() => expect(ctx.get().phase).toBe('finished'));
    expect(transport).toHaveBeenCalledTimes(3); expect(ctx.get()).toMatchObject({ result: 'win', revision: 4 });
  });
  it.each([new AgentHttpError(401), new Error('offline'), { invalid: true }])('pauses on a failed or invalid AI response and retries without fallback (%s)', async (failure) => {
    const transport = vi.fn<DeepSeekTransport>().mockImplementationOnce(async () => { if (failure instanceof Error) throw failure; return completion(failure); }).mockResolvedValue(completion({ type: 'stand' }));
    const ctx = setup(['8', '9', '7', '7'], transport);
    ctx.send({ action: { type: 'stand' } });
    await vi.waitFor(() => expect(ctx.get().error).toBeTruthy());
    expect(ctx.get()).toMatchObject({ phase: 'play', turn: 1, revision: 1, thinking: false });
    expect(ctx.get().error).not.toContain('offline');
    ctx.send({ type: 'retry', apiKey: 'replacement' });
    await vi.waitFor(() => expect(ctx.get().phase).toBe('finished'));
    expect(ctx.get()).toMatchObject({ error: null, revision: 2 }); expect(transport).toHaveBeenCalledTimes(2);
  });
  it('aborts timed out model decisions and ignores late replies', async () => {
    let signal: AbortSignal | undefined; let resolveReply: (value: unknown) => void = () => {};
    const transport: DeepSeekTransport = async (_credentials, _request, incoming) => { signal = incoming; return await new Promise((resolve) => { resolveReply = resolve; }); };
    const ctx = setup(['8', '9', '7', '7'], transport, undefined, 10);
    ctx.send({ action: { type: 'stand' } });
    await vi.waitFor(() => expect(ctx.get().error).toContain('超时'));
    expect(signal?.aborted).toBe(true); resolveReply(completion({ type: 'stand' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ctx.get().revision).toBe(1); expect(ctx.get().phase).toBe('play');
  });
  it('persists a natural with zero decisions and restarts into a new generation', () => {
    const data = new DataStore(); stores.push(data);
    const ctx = setup(['A', '9', 'K', '7'], stand, data);
    const id = ctx.grant.room.id + '_1';
    expect(data.get(id)).toMatchObject({ game: 'blackjack', rulesVersion: BLACKJACK_RULES_VERSION, steps: 0, status: 'finished' });
    const old = ctx.get(); const next = ctx.send({ type: 'restart' });
    expect(next.generation).toBe(2); expect(data.query({ game: 'blackjack' }).total).toBe(2);
    expect(() => ctx.manager.control(old.id, ctx.grant.token, { generation: old.generation, revision: old.revision, type: 'restart' })).toThrow('牌局已更新');
  });
  it('does not change state when saving fails and does not expose active journals', () => {
    const data = new DataStore(); stores.push(data);
    const ctx = setup(['8', '9', '7', '7'], stand, data); const before = ctx.get();
    expect(data.get(before.id + '_1')).toBeNull();
    const fail = vi.spyOn(data, 'save').mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => ctx.send({ action: { type: 'stand' } })).toThrow('保存失败'); expect(ctx.get()).toEqual(before);
    fail.mockRestore(); ctx.manager.close(before.id, ctx.grant.token);
    expect(data.get(before.id + '_1')).toMatchObject({ status: 'abandoned', steps: 0 });
  });
  it('closes an in-flight AI game without letting its late response persist or restart it', async () => {
    const data = new DataStore(); stores.push(data);
    let signal: AbortSignal | undefined; let resolveReply: (value: unknown) => void = () => {};
    const transport: DeepSeekTransport = async (_credentials, _request, incoming) => { signal = incoming; return await new Promise((resolve) => { resolveReply = resolve; }); };
    const ctx = setup(['8', '9', '7', '7'], transport, data);
    ctx.send({ action: { type: 'stand' } }); ctx.manager.close(ctx.grant.room.id, ctx.grant.token);
    expect(signal?.aborted).toBe(true); resolveReply(completion({ type: 'stand' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(() => ctx.get()).toThrow('房间不存在');
    expect(data.get(ctx.grant.room.id + '_1')).toMatchObject({ status: 'abandoned', steps: 1 });
  });
  it('serves token-authorized routes and rejects cross-origin control', async () => {
    vi.spyOn(game, 'createBlackjackGame').mockImplementation(() => createBlackjackGame(ordered('8', '9', '7', '7')));
    const server = createReplayServer({ deepseek: { apiKey: 'test-key', transport: stand } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const headers = { 'content-type': 'application/json', origin: base };
    try {
      const response = await fetch(base + '/api/blackjack/rooms', { method: 'POST', headers, body: '{}' }); expect(response.status).toBe(201);
      const grant = await response.json() as BlackjackRoomGrant; const path = base + '/api/blackjack/rooms/' + grant.room.id;
      expect((await fetch(path)).status).toBe(403);
      expect((await fetch(path, { method: 'POST', headers: { ...headers, authorization: 'Bearer ' + grant.token, origin: 'https://evil.invalid' }, body: '{}' })).status).toBe(403);
      const visible = await (await fetch(path, { headers: { authorization: 'Bearer ' + grant.token } })).json();
      expect(visible.opponent).toEqual([expect.objectContaining({ rank: '9' }), null]);
      const action = await fetch(path, { method: 'POST', headers: { ...headers, authorization: 'Bearer ' + grant.token }, body: JSON.stringify({ revision: 0, generation: 1, action: { type: 'stand' } }) });
      expect(action.status).toBe(200);
      expect((await fetch(base + '/blackjack')).status).toBe(200);
      expect((await fetch(base + '/blackjack/' + grant.room.id)).status).toBe(200);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
