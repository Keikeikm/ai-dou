import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createBluffGame, applyBluffAction, observeBluff } from '../server/bluff/game.js';
import { BluffRooms } from '../server/bluff/rooms.js';
import { AgentHttpError } from '../server/agents/http.js';
import type { DeepSeekCompletionRequest, DeepSeekTransport } from '../server/agents/deepseek.js';
import { createReplayServer } from '../server/http/replay-server.js';
import { BLUFF_RULES_VERSION, LEGACY_BLUFF_RULES_VERSION, type BluffObservation, type BluffRoomGrant } from '../shared/bluff.js';

const managers: BluffRooms[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.dispose(); vi.useRealTimers(); });
const completion = (action: unknown) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(action) } }] });
const transport: DeepSeekTransport = async (_credentials, request) => {
  const view = JSON.parse(request.messages[1].content) as BluffObservation;
  return completion(view.phase === 'respond' ? { type: 'accept' } : { type: 'play', cards: [view.hand[0].id] });
};
function setup(custom: DeepSeekTransport = transport, timeout = 15000) {
  const manager = new BluffRooms({ apiKey: 'test-key', transport: custom }, timeout);
  managers.push(manager);
  const grant = manager.create({});
  const send = (input: Record<string, unknown>) => {
    const view = manager.get(grant.room.id, grant.token);
    return manager.control(view.id, grant.token, { ...input, revision: view.revision, generation: view.generation });
  };
  return { manager, grant, send, get: () => manager.get(grant.room.id, grant.token) };
}

describe('bluff authoritative rules', () => {
  it('deals 52 unique non-jokers and hides every opposing card and covered play', () => {
    const state = createBluffGame();
    expect(state.hands.map((hand) => hand.length)).toEqual([26, 26]);
    expect(new Set(state.hands.flat().map((card) => card.id)).size).toBe(52);
    const hidden = state.hands[0][0];
    applyBluffAction(state, 0, { type: 'play', cards: [hidden.id] });
    const observation = observeBluff(state, 1);
    expect(observation.claim).toEqual({ seat: 0, rank: 'A', count: 1 });
    for (const card of [...state.hands[0], hidden]) expect(JSON.stringify(observation)).not.toContain(card.id);
    expect(observation).not.toHaveProperty('pile');
    expect(observation).not.toHaveProperty('hands');
    observation.hand.pop();
    expect(state.hands[1]).toHaveLength(26);
  });
  it('rejects wrong turns, duplicate cards, wrong ownership, empty and oversized plays without mutation', () => {
    const state = createBluffGame();
    const before = structuredClone(state);
    const id = state.hands[0][0].id;
    for (const action of [{ type: 'play', cards: [] }, { type: 'play', cards: [id, id] }, { type: 'play', cards: [state.hands[1][0].id] },
      { type: 'play', cards: state.hands[0].slice(0, 5).map((card) => card.id) }, { type: 'challenge' }, { type: 'play', cards: [id], rank: 'K' }]) {
      expect(() => applyBluffAction(state, 0, action)).toThrow();
      expect(state).toEqual(before);
    }
    expect(() => applyBluffAction(state, 1, { type: 'play', cards: [state.hands[1][0].id] })).toThrow();
  });
  it.each([false, true])('collects the whole pile for the correct loser (lied=%s)', (lied) => {
    const state = createBluffGame(() => .999);
    const first = state.hands[0].find((card) => card.rank === 'A')!;
    applyBluffAction(state, 0, { type: 'play', cards: [first.id] });
    applyBluffAction(state, 1, { type: 'accept' });
    expect(state.pile).toHaveLength(1);
    expect(state.rankIndex).toBe(1);
    const second = state.hands[1].find((card) => (card.rank === '2') !== lied)!;
    applyBluffAction(state, 1, { type: 'play', cards: [second.id] });
    applyBluffAction(state, 0, { type: 'challenge' });
    expect(state.lastReveal).toMatchObject({ lied, loser: lied ? 1 : 0, collected: 2, cards: [second] });
    expect(state.hands[lied ? 1 : 0]).toHaveLength(27);
    expect(state.pile).toHaveLength(0);
    expect(state.turn).toBe(lied ? 0 : 1);
    expect(state.lastReveal?.nextSeat).toBe(state.turn);
    expect(state.rankIndex).toBe(2);
    expect(state.hands.flat()).toHaveLength(52);
  });
  it('treats a mix of true and false cards as a lie', () => {
    const state = createBluffGame(() => .999);
    const cards = [state.hands[0].find((card) => card.rank === 'A')!, state.hands[0].find((card) => card.rank !== 'A')!];
    applyBluffAction(state, 0, { type: 'play', cards: cards.map((card) => card.id) });
    applyBluffAction(state, 1, { type: 'challenge' });
    expect(state.lastReveal?.lied).toBe(true);
    expect(state.hands[0]).toHaveLength(26);
  });
  it.each([0, 1] as const)('gives successful challenger %s the next play and rejects the caught liar', (challenger) => {
    const state = createBluffGame(() => .999);
    if (challenger === 0) {
      applyBluffAction(state, 0, { type: 'play', cards: [state.hands[0][0].id] });
      applyBluffAction(state, 1, { type: 'accept' });
    }
    const claimant = challenger === 0 ? 1 : 0;
    const rank = observeBluff(state, claimant).rank;
    const lie = state.hands[claimant].find((card) => card.rank !== rank)!;
    applyBluffAction(state, claimant, { type: 'play', cards: [lie.id] });
    applyBluffAction(state, challenger, { type: 'challenge' });
    expect(state.lastReveal).toMatchObject({ challenger, claimant, lied: true, loser: claimant });
    expect(state).toMatchObject({ phase: 'play', turn: challenger });
    expect(() => applyBluffAction(state, claimant, { type: 'play', cards: [state.hands[claimant][0].id] })).toThrow('还没轮到你');
    applyBluffAction(state, challenger, { type: 'play', cards: [state.hands[challenger][0].id] });
    expect(state.pending?.seat).toBe(challenger);
  });
  it.each([0, 1] as const)('lets truthful claimant %s lead after a failed challenge', (claimant) => {
    const state = createBluffGame(() => .999);
    if (claimant === 1) { applyBluffAction(state, 0, { type: 'play', cards: [state.hands[0][0].id] }); applyBluffAction(state, 1, { type: 'accept' }); }
    const rank = observeBluff(state, claimant).rank;
    const challenger = claimant === 0 ? 1 : 0;
    applyBluffAction(state, claimant, { type: 'play', cards: [state.hands[claimant].find((card) => card.rank === rank)!.id] });
    applyBluffAction(state, challenger, { type: 'challenge' });
    expect(state).toMatchObject({ turn: claimant, phase: 'play', rulesVersion: BLUFF_RULES_VERSION });
    expect(state.lastReveal).toMatchObject({ lied: false, loser: challenger, nextSeat: claimant });
    expect(() => applyBluffAction(state, challenger, { type: 'play', cards: [state.hands[challenger][0].id] })).toThrow('还没轮到你');
  });
  it('retains the old next-player rule when replaying a v1 game', () => {
    const state = createBluffGame(() => .999, LEGACY_BLUFF_RULES_VERSION);
    applyBluffAction(state, 0, { type: 'play', cards: [state.hands[0].find((card) => card.rank === 'A')!.id] });
    applyBluffAction(state, 1, { type: 'challenge' });
    expect(state.lastReveal).toMatchObject({ lied: false, loser: 1, nextSeat: 1 });
    expect(state.turn).toBe(1);
  });
  it.each([['accept', true, true], ['challenge', false, true], ['challenge', true, false]] as const)('resolves the last hand before victory (%s, lied=%s)', (response, lied, wins) => {
    const state = createBluffGame(() => .999);
    const card = state.hands[0].find((item) => (item.rank === 'A') !== lied)!;
    state.hands[1].push(...state.hands[0].filter((item) => item.id !== card.id));
    state.hands[0] = [card];
    applyBluffAction(state, 0, { type: 'play', cards: [card.id] });
    expect(state.phase).toBe('respond'); expect(state.winner).toBeNull();
    applyBluffAction(state, 1, { type: response });
    expect(state.winner).toBe(wins ? 0 : null);
    expect(state.phase).toBe(wins ? 'finished' : 'play');
    if (wins) expect(() => applyBluffAction(state, 1, { type: 'play', cards: [state.hands[1][0].id] })).toThrow();
  });
  it('cycles K back to A and conserves cards during full games with challenges', () => {
    for (let game = 0; game < 10; game++) {
      const state = createBluffGame();
      for (let step = 0; step < 300 && state.phase !== 'finished'; step++) {
        const seat = state.turn;
        const before = state.rankIndex;
        const responding = state.phase === 'respond';
        applyBluffAction(state, seat, responding ? { type: step % 3 === 0 ? 'challenge' : 'accept' }
          : { type: 'play', cards: state.hands[seat].slice(0, 4).map((card) => card.id) });
        const cards = [...state.hands.flat(), ...state.pile];
        expect(cards).toHaveLength(52); expect(new Set(cards.map((card) => card.id)).size).toBe(52);
        if (responding && state.phase !== 'finished') expect(state.rankIndex).toBe((before + 1) % 13);
      }
    }
  });
});

describe('bluff model lifecycle', () => {
  it('lets the human lead after catching the model, without an extra model play', async () => {
    const decide = vi.fn<DeepSeekTransport>(async (_credentials, request) => {
      const view = JSON.parse(request.messages[1].content) as BluffObservation;
      return completion(view.phase === 'respond' ? { type: 'accept' } : { type: 'play', cards: [view.hand.find((card) => card.rank !== view.rank)!.id] });
    });
    const game = setup(decide);
    game.send({ action: { type: 'play', cards: [game.get().hand[0].id] } });
    await vi.waitFor(() => expect(game.get()).toMatchObject({ thinking: false, phase: 'respond', turn: 0 }));
    expect(decide).toHaveBeenCalledTimes(2);
    const next = game.send({ action: { type: 'challenge' } });
    expect(next).toMatchObject({ thinking: false, phase: 'play', turn: 0, lastReveal: { challenger: 0, loser: 1, lied: true } });
    expect(next.revealPending).toBe(next.revision);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(() => game.send({ action: { type: 'play', cards: [next.hand[0].id] } })).toThrow('确认翻牌');
    game.send({ type: 'ack-reveal', revealRevision: next.revealPending });
    game.send({ action: { type: 'play', cards: [next.hand[0].id] } });
    expect(game.get().history.at(-1)).toMatchObject({ type: 'play', seat: 0 });
  });
  it('lets the model lead after catching the human; the following human turn is a response', async () => {
    const game = setup(async (_credentials, request) => {
      const view = JSON.parse(request.messages[1].content) as BluffObservation;
      return completion(view.phase === 'respond' ? { type: 'challenge' } : { type: 'play', cards: [view.hand[0].id] });
    });
    game.send({ action: { type: 'play', cards: [game.get().hand.find((card) => card.rank !== 'A')!.id] } });
    await vi.waitFor(() => expect(game.get()).toMatchObject({ thinking: false, phase: 'play', turn: 1, revision: 2, revealPending: 2 }));
    expect(game.get().history.map((event) => [event.seat, event.type])).toEqual([[0, 'play'], [1, 'challenge']]);
    expect(() => game.send({ type: 'ack-reveal', revealRevision: 1 })).toThrow('过期');
    game.send({ type: 'ack-reveal', revealRevision: 2 });
    await vi.waitFor(() => expect(game.get()).toMatchObject({ thinking: false, phase: 'respond', turn: 0, revision: 3, revealPending: null }));
    expect(game.get().lastReveal).toMatchObject({ challenger: 1, loser: 0, lied: true });
    expect(game.get().history.map((event) => [event.seat, event.type])).toEqual([[0, 'play'], [1, 'challenge'], [1, 'play']]);
    expect(() => game.send({ action: { type: 'play', cards: [game.get().hand[0].id] } })).toThrow('相信或质疑');
  });
  it.each([0, 1] as const)('awards the next play to truthful seat %s only after reveal confirmation', async (claimant) => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(.999);
    const decide = vi.fn<DeepSeekTransport>(async (_credentials, request) => {
      const view = JSON.parse(request.messages[1].content) as BluffObservation;
      return completion(view.phase === 'respond' ? { type: claimant === 0 ? 'challenge' : 'accept' } : { type: 'play', cards: [view.hand.find((card) => card.rank === view.rank)!.id] });
    });
    const game = setup(decide); random.mockRestore();
    game.send({ action: { type: 'play', cards: [game.get().hand.find((card) => card.rank === 'A')!.id] } });
    await vi.waitFor(() => expect(game.get().thinking).toBe(false));
    if (claimant === 1) game.send({ action: { type: 'challenge' } });
    const revealed = game.get();
    expect(revealed.lastReveal).toMatchObject({ lied: false, nextSeat: claimant });
    expect(revealed.turn).toBe(claimant);
    expect(revealed.revealPending).toBe(revealed.revision);
    const count = decide.mock.calls.length;
    await Promise.resolve(); expect(decide).toHaveBeenCalledTimes(count);
    game.send({ type: 'ack-reveal', revealRevision: revealed.revision });
    await vi.waitFor(() => expect(game.get().thinking).toBe(false));
    if (claimant === 0) { expect(game.get()).toMatchObject({ turn: 0, phase: 'play' }); expect(decide).toHaveBeenCalledTimes(count); }
    else { expect(game.get().history.at(-1)).toMatchObject({ seat: 1, type: 'play' }); expect(decide).toHaveBeenCalledTimes(count + 1); }
    expect(() => game.send({ type: 'ack-reveal', revealRevision: revealed.revision })).toThrow('已确认');
  });
  it('requires a key, authenticates reads and rejects stale or duplicate commands', async () => {
    const empty = new BluffRooms(); managers.push(empty);
    expect(() => empty.create({})).toThrow(/API key/);
    const game = setup();
    expect(() => game.manager.get(game.grant.room.id, undefined)).toThrow(/席位/);
    const { room, token } = game.grant;
    const command = { revision: 0, generation: 1, action: { type: 'play', cards: [room.hand[0].id] } };
    game.manager.control(room.id, token, command);
    expect(() => game.manager.control(room.id, token, command)).toThrow(/更新/);
    await vi.waitFor(() => expect(game.get().thinking).toBe(false));
    expect(game.get()).toMatchObject({ turn: 0, phase: 'respond', revision: 3, error: null });
    expect(JSON.stringify(game.get())).not.toContain('test-key');
  });
  it('sends only the model private observation and pauses on invalid actions without fallback', async () => {
    const requests: DeepSeekCompletionRequest[] = [];
    const game = setup(async (_credentials, request) => { requests.push(request); return completion({ type: 'play', cards: ['not-your-card'] }); });
    game.send({ action: { type: 'play', cards: [game.grant.room.hand[0].id] } });
    await vi.waitFor(() => expect(game.get().error).toMatch(/不合法/));
    expect(game.get().revision).toBe(1); expect(requests).toHaveLength(1);
    const payload = JSON.parse(requests[0].messages[1].content);
    expect(payload.seat).toBe(1); expect(payload.hand).toHaveLength(26);
    for (const card of game.grant.room.hand) expect(JSON.stringify(payload)).not.toContain(card.id);
    game.send({ type: 'retry' });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
  });
  it('can replace an invalid key and resume the same game', async () => {
    const game = setup(async (credentials, request, signal) => {
      if (credentials.apiKey !== 'replacement') throw new AgentHttpError(401);
      return transport(credentials, request, signal);
    });
    game.send({ action: { type: 'play', cards: [game.grant.room.hand[0].id] } });
    await vi.waitFor(() => expect(game.get().error).toMatch(/密钥/));
    game.send({ type: 'retry', apiKey: 'replacement' });
    await vi.waitFor(() => expect(game.get()).toMatchObject({ revision: 3, error: null, thinking: false }));
  });
  it('times out even when a transport ignores cancellation and ignores its late response', async () => {
    let finish!: (value: unknown) => void;
    const game = setup(() => new Promise((resolve) => { finish = resolve; }), 10);
    game.send({ action: { type: 'play', cards: [game.grant.room.hand[0].id] } });
    await vi.waitFor(() => expect(game.get().error).toMatch(/超时/));
    finish(completion({ type: 'accept' }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(game.get().revision).toBe(1);
  });
  it('completes a full model game, restarts and rejects commands from the previous generation', async () => {
    const game = setup(async (_credentials, request) => {
      const view = JSON.parse(request.messages[1].content) as BluffObservation;
      return completion(view.phase === 'respond' ? { type: 'accept' } : { type: 'play', cards: view.hand.slice(0, 4).map((card) => card.id) });
    });
    for (let step = 0; step < 40 && game.get().phase !== 'finished'; step++) {
      await vi.waitFor(() => expect(game.get().thinking).toBe(false));
      const view = game.get();
      if (view.phase === 'finished') break;
      game.send({ action: view.phase === 'respond' ? { type: 'accept' } : { type: 'play', cards: view.hand.slice(0, 4).map((card) => card.id) } });
    }
    await vi.waitFor(() => expect(game.get().phase).toBe('finished'));
    expect(game.get().winner).toBe(0);
    game.send({ type: 'restart' });
    expect(game.get()).toMatchObject({ generation: 2, phase: 'play', revision: 0, winner: null });
    expect(game.get().hand).toHaveLength(26);
    expect(() => game.manager.control(game.grant.room.id, game.grant.token, { generation: 1, revision: 0, action: { type: 'play', cards: [game.get().hand[0].id] } })).toThrow(/更新/);
    game.manager.close(game.grant.room.id, game.grant.token);
    expect(() => game.get()).toThrow(/不存在/);
  });
});

it('serves production bluff routes and enforces private same-origin APIs', async () => {
  const server = createReplayServer({ deepseek: { apiKey: 'test-key', transport } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const headers = { 'Content-Type': 'application/json' };
  try {
    expect((await fetch(origin + '/bluff')).status).toBe(200);
    expect((await fetch(origin + '/api/bluff/rooms', { method: 'POST', headers: { ...headers, Origin: 'http://evil.example' }, body: '{}' })).status).toBe(403);
    const created = await fetch(origin + '/api/bluff/rooms', { method: 'POST', headers, body: '{}' });
    expect(created.status).toBe(201);
    const grant = await created.json() as BluffRoomGrant;
    expect((await fetch(origin + '/bluff/' + grant.room.id)).status).toBe(200);
    const url = origin + '/api/bluff/rooms/' + grant.room.id;
    expect((await fetch(url)).status).toBe(403);
    const auth = { ...headers, Authorization: 'Bearer ' + grant.token };
    const read = await (await fetch(url, { headers: auth })).json();
    expect(read.hand).toHaveLength(26); expect(read).not.toHaveProperty('hands');
    expect((await fetch(url, { method: 'POST', headers: auth, body: '{invalid' })).status).toBe(400);
    expect((await fetch(url, { method: 'DELETE', headers: auth, body: '{}' })).status).toBe(200);
    expect((await fetch(url, { headers: auth })).status).toBe(404);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
