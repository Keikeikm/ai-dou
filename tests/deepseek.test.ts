import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createDefaultBots, legalBotActions } from '../server/agents/bots.js';
import { runReplayGame } from '../server/agents/bot-game.js';
import { createAgentRequest, parseAgentResponse, type AgentResponse } from '../server/agents/protocol.js';
import { DEEPSEEK_API_URL, DeepSeekDecisionAgent, checkDeepSeekConnection, type DeepSeekCompletionRequest, type DeepSeekTransport } from '../server/agents/deepseek.js';
import { AgentHttpError, AgentTransportError } from '../server/agents/http.js';
import { createGame } from '../server/game/game.js';
import { applyGameAction } from '../server/game/actions.js';
import { GameScheduler, replayJournal } from '../server/rooms/scheduler.js';
import { RoomManager } from '../server/rooms/room-manager.js';
import { createReplayServer } from '../server/http/replay-server.js';

const managers: RoomManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.dispose(); });

function context(sequence = 1) { return { sequence, deadline: Date.now() + 15000, signal: new AbortController().signal }; }
function response(content: unknown, finishReason = 'stop') { return { choices: [{ finish_reason: finishReason, message: { content } }] }; }
function input(request: DeepSeekCompletionRequest) { return JSON.parse(request.messages[1].content) as {
  game: ReturnType<typeof createAgentRequest>; action_options: (Omit<AgentResponse, 'protocol_version' | 'request_id'> & { index: number; card_type?: string })[];
}; }
const chooseFirst: DeepSeekTransport = async () => response('{"action_index":0}');

describe('DeepSeek model adapter', () => {
  it('uses the fixed official endpoint, JSON output and a server-owned Bearer key without exposing other hands', async () => {
    const state = createGame(7);
    let captured!: DeepSeekCompletionRequest;
    const agent = new DeepSeekDecisionAgent('DeepSeek', () => 'test-only-secret', 'room_123456abcdef', 1, { transport: async (credentials, request, signal) => {
      expect(credentials).toEqual({ apiUrl: DEEPSEEK_API_URL, apiKey: 'test-only-secret' });
      expect(signal.aborted).toBe(false);
      captured = request;
      return response('{"action_index":0}');
    } });
    expect(await agent.decide(state, context())).toEqual({ type: 'call', score: 0 });
    expect(captured).toMatchObject({ model: 'deepseek-flash', thinking: { type: 'disabled' }, response_format: { type: 'json_object' }, stream: false, max_tokens: 256 });
    expect(captured.messages[0].content).toContain('JSON');
    expect(JSON.stringify(captured)).not.toContain('test-only-secret');
    const game = input(captured).game;
    expect(game.hand_cards).toEqual(state.hands[0].map((card) => card.id));
    expect(game.bottom_cards).toEqual([]);
    expect(game).not.toHaveProperty('hands');
    const cardIds = JSON.stringify(captured.messages);
    for (const card of [...state.hands[1], ...state.hands[2], ...state.bottomCards]) expect(cardIds).not.toContain(card.id);
  });

  it('offers legal multi-card choices including pairs and three-with-a-pair instead of asking for arbitrary card IDs', async () => {
    let state = createGame(7);
    state = applyGameAction(state, 0, { type: 'call', score: 0 });
    state = applyGameAction(state, 1, { type: 'call', score: 2 });
    state = applyGameAction(state, 2, { type: 'call', score: 3 });
    const agent = new DeepSeekDecisionAgent('DeepSeek', () => 'test', 'room_123456abcdef', 1, { transport: async (_, request) => {
      const { game, action_options: actions } = input(request);
      expect(actions.length).toBeLessThanOrEqual(96);
      expect(actions.some((action) => action.card_type === 'pair')).toBe(true);
      expect(actions.some((action) => action.card_type === 'triple-pair')).toBe(true);
      expect(actions.some((action) => action.action === 'pass')).toBe(false);
      for (const action of actions) {
        const { index: position, card_type: cardType, ...envelope } = action;
        expect(() => applyGameAction(state, state.currentSeat, parseAgentResponse({ protocol_version: 1, request_id: game.request_id, ...envelope }, game, state))).not.toThrow();
        expect(position).toBeGreaterThanOrEqual(0);
        if (cardType) expect(envelope.cards?.length).toBeGreaterThan(0);
      }
      return response(JSON.stringify({ action_index: actions.find((action) => action.card_type === 'triple-pair')!.index }));
    } });
    const action = await agent.decide(state, context(4));
    expect(action.type).toBe('play');
    if (action.type === 'play') expect(action.cards).toHaveLength(5);
    expect(() => applyGameAction(state, state.currentSeat, action)).not.toThrow();
  });

  it.each(['', 'not json', '```json\n{"action_index":0}\n```', '{}', '{"action_index":-1}', '{"action_index":10000}', '{"action_index":0.5}', '{"action_index":"0"}', '{"action_index":0,"reason":"secret"}', 'null'])('rejects malformed or out-of-range model decisions: %s', async (content) => {
    const agent = new DeepSeekDecisionAgent('DeepSeek', () => 'test', 'room_123456abcdef', 1, { transport: async () => response(content) });
    await expect(agent.decide(createGame(7), context())).rejects.toThrow(/DeepSeek/);
  });

  it.each(['length', 'content_filter', 'tool_calls', 'aborted'])('rejects unfinished model output with reason %s', async (finishReason) => {
    const agent = new DeepSeekDecisionAgent('DeepSeek', () => 'test', 'room_123456abcdef', 1, { transport: async () => response('{"action_index":0}', finishReason) });
    await expect(agent.decide(createGame(7), context())).rejects.toThrow(/incomplete/);
  });

  it('does not contact the model without a key or after cancellation, and does not log vendor response bodies', async () => {
    let requests = 0;
    const agent = new DeepSeekDecisionAgent('DeepSeek', () => undefined, 'room_123456abcdef', 1, { transport: async () => { requests += 1; return response('{"action_index":0}'); } });
    await expect(agent.decide(createGame(7), context())).rejects.toThrow(/not configured/);
    const controller = new AbortController();
    controller.abort();
    await expect(agent.decide(createGame(7), { ...context(), signal: controller.signal })).rejects.toThrow();
    expect(requests).toBe(0);
    const broken = new DeepSeekDecisionAgent('DeepSeek', () => 'secret-key', 'room_123456abcdef', 1, { transport: async () => { throw new Error('secret-key vendor-body'); } });
    await expect(broken.decide(createGame(7), context())).rejects.toThrow('DeepSeek request failed or was cancelled');
  });

  it.each([401, 429, 503])('reports only safe status information for HTTP %s without retrying', async (status) => {
    let requests = 0;
    const agent = new DeepSeekDecisionAgent('DeepSeek', () => 'test', 'room_123456abcdef', 1, { transport: async () => { requests += 1; throw new AgentHttpError(status); } });
    await expect(agent.decide(createGame(7), context())).rejects.toThrow('HTTP ' + status);
    expect(requests).toBe(1);
  });

  it('ignores a late model response after a cancelled decision', async () => {
    let resolveResponse!: (value: unknown) => void;
    let signal!: AbortSignal;
    const agent = new DeepSeekDecisionAgent('DeepSeek', () => 'test', 'room_123456abcdef', 1, { transport: (_credentials, _request, abortSignal) => {
      signal = abortSignal;
      return new Promise((resolve) => { resolveResponse = resolve; });
    } });
    const scheduler = new GameScheduler([agent, agent, agent], { turnTimeoutMs: 15000 });
    const pending = scheduler.step();
    await Promise.resolve();
    scheduler.pause();
    await pending;
    expect(signal.aborted).toBe(true);
    resolveResponse(response('{"action_index":0}'));
    await Promise.resolve();
    expect(scheduler.getReplay().turns).toHaveLength(0);
    expect(scheduler.getSession().decision).toBeNull();
    scheduler.stop();
  });

  it('validates model selection and never lets model data change rules', () => {
    expect(() => new DeepSeekDecisionAgent('DeepSeek', () => 'test', 'room_123456abcdef', 1, { model: 'untrusted-model' as 'deepseek-flash' })).toThrow(/model/);
    for (const state of runReplayGame(createDefaultBots(7), 7)) for (const action of legalBotActions(state)) expect(() => applyGameAction(state, state.currentSeat, action)).not.toThrow();
  });
});

describe('DeepSeek connection checks', () => {
  it.each(['dns_failed', 'tls_failed', 'connection_failed', 'response_failed'] as const)('reports %s rather than falsely marking API keys unauthorized', async (error) => {
    const result = await checkDeepSeekConnection({ apiKey: 'test-only-secret', transport: async () => { throw new AgentTransportError(error); } }, 100, new AbortController().signal);
    expect(result).toMatchObject({ verified: false, error });
    expect(JSON.stringify(result)).not.toContain('test-only-secret');
  });
  it('supports a 150-second configured deadline while rejecting unbounded model timeouts', async () => {
    const manager = new RoomManager({ deepseekTurnTimeoutMs: 150000, deepseek: { apiKey: 'test', transport: chooseFirst } });
    managers.push(manager);
    const room = manager.create({ players: [0, 1, 2].map((seat) => ({ name: 'AI ' + seat, kind: 'deepseek', seat })) });
    expect(manager.getReplay(room.id).session.turnTimeoutMs).toBe(150000);
    expect(await manager.checkAgent(room.id, room.players[0].id)).toMatchObject({ verified: true });
    expect(() => new RoomManager({ deepseekTurnTimeoutMs: 300001 })).toThrow(/timeout/);
    await expect(checkDeepSeekConnection({ apiKey: 'test', transport: chooseFirst }, 300001, new AbortController().signal)).rejects.toThrow(/timeout/);
  });

  it('checks one synthetic decision without changing room state, keys, scores, generation or journals', async () => {
    let requests = 0;
    const manager = new RoomManager({ deepseek: { apiKey: 'server-test-key', transport: async (credentials, request) => {
      requests += 1;
      expect(credentials.apiKey).toBe('seat-test-key');
      expect(input(request).game.room_id).toBe('room_000000000000');
      expect(input(request).game.hand_cards).toEqual(createGame(7).hands[0].map((card) => card.id));
      expect(request.messages).toHaveLength(2);
      return response('{"action_index":0}');
    } } });
    managers.push(manager);
    const room = manager.create({ seed: 21, players: [0, 1, 2].map((seat) => ({ name: 'AI ' + seat, kind: 'deepseek', seat, api_key: seat === 2 ? 'seat-test-key' : null })) });
    const before = manager.getReplay(room.id);
    const journal = manager.getJournal(room.id);
    const result = await manager.checkAgent(room.id, room.players[2].id);
    expect(result).toMatchObject({ verified: true, model: 'deepseek-flash' });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.checkedAt).toBeGreaterThan(0);
    expect(requests).toBe(1);
    const after = manager.getReplay(room.id);
    expect(after.room).toEqual(before.room);
    expect(after.snapshots).toEqual(before.snapshots);
    expect(after.turns).toEqual(before.turns);
    expect(after.session.status).toBe('idle');
    expect(after.accounting).toBeNull();
    expect(manager.getJournal(room.id)).toEqual(journal);
    expect(manager.getRoomGames(room.id)).toMatchObject({ total: 0, games: [] });
    expect(manager.getDeepSeekConfiguration()).toEqual({ model: 'deepseek-flash', hasServerKey: true, turnTimeoutMs: 15000 });
    expect(JSON.stringify([result, after, manager.getDeepSeekConfiguration()])).not.toMatch(/server-test-key|seat-test-key/);
  });

  it.each([[401, 'unauthorized'], [403, 'unauthorized'], [402, 'insufficient_balance'], [429, 'rate_limited'], [503, 'provider_error']] as const)('sanitizes HTTP %s and makes no retries', async (status, code) => {
    let requests = 0;
    const result = await checkDeepSeekConnection({ apiKey: 'test', transport: async () => { requests += 1; throw new AgentHttpError(status); } }, 100, new AbortController().signal);
    expect(result).toMatchObject({ verified: false, error: code });
    expect(requests).toBe(1);
  });

  it('reports invalid output and sanitized connection errors rather than fallback success', async () => {
    const invalid = await checkDeepSeekConnection({ apiKey: 'test', transport: async () => response('{}') }, 100, new AbortController().signal);
    expect(invalid).toMatchObject({ verified: false, error: 'invalid_response' });
    const broken = await checkDeepSeekConnection({ apiKey: 'secret-key', transport: async () => { throw new Error('secret-key vendor-body'); } }, 100, new AbortController().signal);
    expect(broken).toMatchObject({ verified: false, error: 'connection_failed' });
    expect(JSON.stringify(broken)).not.toMatch(/secret-key|vendor-body/);
  });

  it('enforces a bounded timeout even if the transport ignores cancellation', async () => {
    let signal!: AbortSignal;
    const result = await checkDeepSeekConnection({ apiKey: 'test', transport: (_credentials, _request, abortSignal) => { signal = abortSignal; return new Promise(() => undefined); } }, 10, new AbortController().signal);
    expect(result).toMatchObject({ verified: false, error: 'timeout' });
    expect(signal.aborted).toBe(true);
  });

  it('rejects missing keys or invalid timeouts and avoids requests after cancellation', async () => {
    let requests = 0;
    const options = { apiKey: 'test', transport: async () => { requests += 1; return response('{"action_index":0}'); } };
    await expect(checkDeepSeekConnection({ ...options, apiKey: undefined }, 100, new AbortController().signal)).rejects.toThrow(/not configured/);
    await expect(checkDeepSeekConnection(options, 300001, new AbortController().signal)).rejects.toThrow(/timeout/);
    const controller = new AbortController();
    controller.abort();
    expect(await checkDeepSeekConnection(options, 100, controller.signal)).toMatchObject({ verified: false, error: 'cancelled' });
    expect(requests).toBe(0);
  });

  it('guards concurrent checks, key updates and game starts and cancels on close', async () => {
    let signal!: AbortSignal;
    const manager = new RoomManager({ deepseek: { apiKey: 'test', transport: (_credentials, _request, abortSignal) => { signal = abortSignal; return new Promise(() => undefined); } } });
    managers.push(manager);
    const room = manager.create({ players: [0, 1, 2].map((seat) => ({ name: 'AI ' + seat, kind: 'deepseek', seat })) });
    const checking = manager.checkAgent(room.id, room.players[0].id);
    await Promise.resolve();
    await expect(manager.checkAgent(room.id, room.players[1].id)).rejects.toThrow(/already in progress/);
    for (const action of ['start', 'step', 'reset', 'new-game']) await expect(manager.control(room.id, action)).rejects.toThrow(/connection check/);
    expect(() => manager.updateApiKey(room.id, room.players[0].id, 'changed')).toThrow(/connection check/);
    manager.close(room.id);
    expect(await checking).toMatchObject({ verified: false, error: 'cancelled' });
    expect(signal.aborted).toBe(true);
    expect(manager.getReplay(room.id).turns).toHaveLength(0);
  });

  it('cancels on client disconnect and releases the check lock for later checks', async () => {
    let calls = 0;
    const manager = new RoomManager({ deepseek: { apiKey: 'test', transport: async () => { calls += 1; if (calls === 1) return new Promise(() => undefined); return response('{"action_index":0}'); } } });
    managers.push(manager);
    const room = manager.create({ players: [{ name: 'AI', kind: 'deepseek' }] });
    const controller = new AbortController();
    const pending = manager.checkAgent(room.id, room.players[0].id, controller.signal);
    await Promise.resolve();
    controller.abort();
    expect(await pending).toMatchObject({ error: 'cancelled' });
    expect(await manager.checkAgent(room.id, room.players[0].id)).toMatchObject({ verified: true });
    expect(calls).toBe(2);
    expect(manager.getReplay(room.id).snapshots).toHaveLength(0);
  });

  it('does not check an unconfigured, built-in, closed or already-started seat', async () => {
    const manager = new RoomManager({ deepseek: { transport: chooseFirst } });
    managers.push(manager);
    const room = manager.create({ players: [{ name: 'AI', kind: 'deepseek' }, { name: 'Bot', kind: 'greedy' }, { name: 'Bot 2', kind: 'greedy' }] });
    await expect(manager.checkAgent(room.id, room.players[0].id)).rejects.toThrow(/API key/);
    await expect(manager.checkAgent(room.id, room.players[1].id)).rejects.toThrow(/not found/);
    manager.updateApiKey(room.id, room.players[0].id, 'test');
    await manager.control(room.id, 'step');
    await expect(manager.checkAgent(room.id, room.players[0].id)).rejects.toThrow(/before/);
    manager.close(room.id);
    await expect(manager.checkAgent(room.id, room.players[0].id)).rejects.toThrow(/closed/);
  });

  it('requires same-origin explicit POST confirmation; configuration GET and HEAD do not contact the provider', async () => {
    let calls = 0;
    const server = createReplayServer({ deepseek: { apiKey: 'test-only-secret', transport: async () => { calls += 1; return response('{"action_index":0}'); } } });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const post = (path: string, body: unknown, headers = {}) => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    try {
      const config = await (await fetch(origin + '/api/providers/deepseek')).json();
      expect(config).toEqual({ hasServerKey: true, model: 'deepseek-flash', turnTimeoutMs: 15000 });
      expect(JSON.stringify(config)).not.toContain('test-only-secret');
      expect(await (await fetch(origin + '/api/providers/deepseek', { method: 'HEAD' })).text()).toBe('');
      expect((await post('/api/providers/deepseek', {})).status).toBe(405);
      const room = await (await post('/api/rooms', { players: [{ name: 'AI', kind: 'deepseek' }] })).json();
      const path = '/api/rooms/' + room.id + '/players/' + room.players[0].id + '/check';
      expect((await fetch(origin + path)).status).toBe(405);
      expect((await post(path, {})).status).toBe(400);
      expect((await post(path, { confirm: true, api_key: 'injected' })).status).toBe(400);
      expect((await post(path, { confirm: true }, { Origin: 'https://evil.example' })).status).toBe(403);
      expect(calls).toBe(0);
      const result = await (await post(path, { confirm: true })).json();
      expect(result).toMatchObject({ verified: true });
      expect(JSON.stringify(result)).not.toContain('test-only-secret');
      expect(calls).toBe(1);
      const replay = await (await fetch(origin + '/api/rooms/' + room.id + '/replay')).json();
      expect(replay.turns).toHaveLength(0);
      expect(replay.snapshots).toHaveLength(0);
      expect(replay.accounting).toBeNull();
    } finally { await new Promise<void>((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections(); }); }
  });
});

describe('DeepSeek room integration', () => {
  it('records response content and allowlisted metadata on the matching turn without keys or reasoning fields', async () => {
    let invalid = false;
    const manager = new RoomManager({ deepseek: { apiKey: 'test-secret-key', transport: async () => ({
      id: 'test-secret-key-reply', model: 'untrusted-provider-model', unknown: 'vendor-body-secret',
      choices: [{ finish_reason: 'stop', message: { content: invalid ? '<script>test-secret-key</script>' : '{"action_index":0}', reasoning_content: 'private-reasoning' } }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, other: 'test-secret-key' },
    }) } });
    managers.push(manager);
    const room = manager.create({ seed: 7, players: [0, 1, 2].map((seat) => ({ name: 'AI ' + seat, kind: 'deepseek', seat })) });
    await manager.control(room.id, 'step');
    const first = manager.getReplay(room.id).turns[0];
    expect(first.modelResponse).toMatchObject({ provider: 'deepseek', model: 'deepseek-flash', status: 'accepted',
      content: '{"action_index":0}', actionIndex: 0, finishReason: 'stop', requestId: '[REDACTED]-reply',
      usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 } });
    expect(first.modelResponse!.durationMs).toBeGreaterThanOrEqual(0);
    invalid = true;
    await manager.control(room.id, 'step');
    const second = manager.getJournal(room.id).turns[1];
    expect(second).toMatchObject({ sequence: 2, seat: 1, source: 'fallback', reason: 'invalid',
      modelResponse: { status: 'invalid', content: '<script>[REDACTED]</script>' } });
    expect(second.modelResponse).not.toHaveProperty('actionIndex');
    expect(manager.getJournal(room.id).turns[0].modelResponse).toEqual(first.modelResponse);
    expect(JSON.stringify(manager.getJournal(room.id))).not.toMatch(/test-secret-key|vendor-body-secret|private-reasoning|untrusted-provider-model/);
    (first.modelResponse!.usage! as { totalTokens: number }).totalTokens = 999;
    expect(manager.getReplay(room.id).turns[0].modelResponse!.usage!.totalTokens).toBe(25);
  });

  it('keeps oversized invalid content bounded and records only HTTP status for rejected requests', async () => {
    let rejectRequest = false;
    const manager = new RoomManager({ deepseek: { apiKey: 'test-secret-key', transport: async () => {
      if (rejectRequest) throw new AgentHttpError(401);
      return response('test-secret-key' + 'x'.repeat(5000));
    } } });
    managers.push(manager);
    const room = manager.create({ players: [0, 1, 2].map((seat) => ({ name: 'AI ' + seat, kind: 'deepseek', seat })) });
    await manager.control(room.id, 'step');
    const first = manager.getJournal(room.id).turns[0].modelResponse!;
    expect(first).toMatchObject({ status: 'invalid', contentTruncated: true });
    expect(first.content).toHaveLength(4096);
    expect(first.content).not.toContain('test-secret-key');
    rejectRequest = true;
    await manager.control(room.id, 'step');
    expect(manager.getJournal(room.id).turns[1].modelResponse).toMatchObject({ status: 'error', httpStatus: 401 });
    expect(manager.getJournal(room.id).turns[1].modelResponse).not.toHaveProperty('content');
  });

  it('preserves model responses in settled archives and starts new generations with an empty response history', async () => {
    const manager = new RoomManager({ deepseek: { apiKey: 'test-secret-key', transport: chooseFirst } });
    managers.push(manager);
    const room = manager.create({ seed: 7, players: [0, 1, 2].map((seat) => ({ name: 'AI ' + seat, kind: 'deepseek', seat })) });
    for (let turn = 0; turn < 300 && manager.get(room.id).status !== 'finished'; turn += 1) await manager.control(room.id, 'step');
    expect(manager.get(room.id).status).toBe('finished');
    const record = manager.getGameRecord(room.gameId);
    expect(record.journal.turns.every((turn) => turn.modelResponse?.content === '{"action_index":0}')).toBe(true);
    expect(replayJournal(record.journal)).toEqual(manager.getReplay(room.id).snapshots);
    await manager.control(room.id, 'new-game');
    expect(manager.getJournal(room.id).turns).toHaveLength(0);
    expect(manager.getGameRecord(record.gameId)).toEqual(record);
  });

  it('records accepted model decisions separately from fallback and preserves keys across random generations', async () => {
    let invalid = false;
    const manager = new RoomManager({ deepseek: { apiKey: 'shared-test-key', transport: async () => response(invalid ? '{}' : '{"action_index":0}') } });
    managers.push(manager);
    const room = manager.create({ seed: 7, players: [0, 1, 2].map((seat) => ({ name: 'AI ' + seat, kind: 'deepseek', seat, api_key: seat === 0 ? 'seat-test-key' : null })) });
    await manager.control(room.id, 'step');
    expect(manager.getReplay(room.id).turns[0]).toMatchObject({ source: 'agent', decisionKind: 'model' });
    invalid = true;
    await manager.control(room.id, 'step');
    expect(manager.getReplay(room.id).turns[1]).toMatchObject({ source: 'fallback', decisionKind: 'model', reason: 'invalid' });
    const next = await manager.control(room.id, 'new-game');
    expect(next.seed).not.toBe(7);
    expect(next.room.players[0]).toMatchObject({ hasApiKey: true, keySource: 'seat' });
    expect(next.room.players[1]).toMatchObject({ hasApiKey: true, keySource: 'server' });
    expect(next.turns).toHaveLength(0);
    expect(next.session.status).toBe('idle');
    expect(JSON.stringify(next)).not.toMatch(/shared-test-key|seat-test-key/);
  });
  it('isolates three seats using the same API key with fresh requests and only the acting seat hand', async () => {
    const seen: number[] = [];
    const initial = createGame(7);
    const manager = new RoomManager({ deepseek: { apiKey: 'shared-test-key', transport: async (credentials, request) => {
      expect(credentials.apiKey).toBe('shared-test-key');
      const { game } = input(request);
      seen.push(game.seat);
      expect(request.messages).toHaveLength(2);
      expect(game.hand_cards).toEqual(initial.hands[game.seat].map((card) => card.id));
      for (const [seat, hand] of initial.hands.entries()) if (seat !== game.seat) for (const card of hand) expect(request.messages[1].content).not.toContain(card.id);
      return response('{"action_index":0}');
    } } });
    managers.push(manager);
    const room = manager.create({ seed: 7, players: [0, 1, 2].map((seat) => ({ name: 'AI ' + seat, kind: 'deepseek', seat })) });
    expect(manager.getReplay(room.id).turns).toHaveLength(0);
    for (const seat of [0, 1, 2]) { await manager.control(room.id, 'step'); expect(seen.at(-1)).toBe(seat); }
    expect(seen).toEqual([0, 1, 2]);
    expect(manager.getReplay(room.id).turns.every((turn) => turn.source === 'agent')).toBe(true);
  });
  it('allows keyless preparation, blocks start and step, and supports write-only keys before starting', async () => {
    let requests = 0;
    const manager = new RoomManager({ deepseek: { transport: async (...args) => { requests += 1; return chooseFirst(...args); } } });
    managers.push(manager);
    const room = manager.create({ players: [0, 1, 2].map((seat) => ({ name: 'DeepSeek ' + seat, kind: 'deepseek', seat })) });
    expect(manager.get(room.id).players.every((player) => player.hasApiKey === false && player.model === 'deepseek-flash')).toBe(true);
    expect(manager.getReplay(room.id).session.turnTimeoutMs).toBe(15000);
    await expect(manager.control(room.id, 'start')).rejects.toThrow(/API key/);
    await expect(manager.control(room.id, 'step')).rejects.toThrow(/API key/);
    expect(manager.getReplay(room.id).session.status).toBe('idle');
    expect(requests).toBe(0);
    for (const player of room.players) manager.updateApiKey(room.id, player.id, 'test-only-key');
    expect(manager.get(room.id).players.every((player) => player.hasApiKey && player.keySource === 'seat')).toBe(true);
    expect(JSON.stringify(manager.get(room.id))).not.toContain('test-only-key');
    await manager.control(room.id, 'step');
    expect(requests).toBe(1);
    expect(() => manager.updateApiKey(room.id, room.players[0].id, 'other-key')).toThrow(/before/);
  });

  it('completes a three-model game, settles once and replays without more calls while preserving private hands every turn', async () => {
    let roomId = '';
    const calls = [0, 0, 0];
    const manager = new RoomManager({ deepseek: { apiKey: 'shared-test-key', transport: async (_, request) => {
      const { game, action_options: actions } = input(request);
      calls[game.seat] += 1;
      const current = manager.getReplay(roomId).snapshots.at(-1)!;
      expect(game.hand_cards).toEqual(current.hands[game.seat].map((card) => card.id));
      const publicBottom = new Set(game.bottom_cards);
      for (const [seat, hand] of current.hands.entries()) if (seat !== game.seat) for (const card of hand) {
        if (!publicBottom.has(card.id)) expect(request.messages[1].content).not.toContain(card.id);
      }
      expect(request.messages).toHaveLength(2);
      const best = actions.find((action) => action.action === 'call_3') ?? actions.find((action) => action.action === 'play') ?? actions[0];
      return response(JSON.stringify({ action_index: best.index }));
    } } });
    managers.push(manager);
    const room = manager.create({ players: [0, 1, 2].map((seat) => ({ name: 'AI ' + seat, kind: 'deepseek', seat })) });
    roomId = room.id;
    for (let step = 0; step < 300 && manager.getReplay(roomId).session.status !== 'finished'; step += 1) await manager.control(roomId, 'step');
    const replay = manager.getReplay(roomId);
    expect(replay.session.status).toBe('finished');
    expect(calls.every((count) => count > 1)).toBe(true);
    expect(replay.turns.every((turn) => turn.source === 'agent')).toBe(true);
    expect(replay.accounting?.status).toBe('recorded');
    const before = [...calls];
    expect(replayJournal(manager.getJournal(roomId))).toEqual(replay.snapshots);
    const archive = manager.getGameRecord(replay.accounting!.gameId);
    expect(replayJournal(archive.journal)).toEqual(replay.snapshots);
    await manager.control(roomId, 'settle');
    expect(manager.getRoomGames(roomId).total).toBe(1);
    expect(calls).toEqual(before);
    expect(JSON.stringify(archive)).not.toMatch(/shared-test-key|api_key|Authorization/);
  });

  it('uses seat overrides before the shared server key and preserves them across new generations', async () => {
    const keys: string[] = [];
    const manager = new RoomManager({ deepseek: { apiKey: 'shared-test-key', model: 'deepseek-v4-pro', transport: async (credentials) => {
      keys.push(credentials.apiKey!);
      return response('{"action_index":0}');
    } } });
    managers.push(manager);
    const room = manager.create({ players: [
      { name: 'DeepSeek 0', kind: 'deepseek', seat: 0, api_key: 'seat-test-key' },
      { name: 'DeepSeek 1', kind: 'deepseek', seat: 1 }, { name: 'Greedy', kind: 'greedy', seat: 2 },
    ] });
    expect(manager.get(room.id).players[0].keySource).toBe('seat');
    expect(manager.get(room.id).players[1].keySource).toBe('server');
    manager.updateApiKey(room.id, room.players[0].id, null);
    expect(manager.get(room.id).players[0].keySource).toBe('server');
    manager.updateApiKey(room.id, room.players[0].id, 'seat-test-key');
    await manager.control(room.id, 'step');
    await manager.control(room.id, 'step');
    expect(keys).toEqual(['seat-test-key', 'shared-test-key']);
    await manager.control(room.id, 'reset');
    expect(manager.get(room.id).players[0].keySource).toBe('seat');
    expect(manager.get(room.id).players[0].model).toBe('deepseek-v4-pro');
    expect(JSON.stringify(manager.getReplay(room.id))).not.toMatch(/shared-test-key|seat-test-key/);
  });

  it('finishes and archives a mixed room entirely with mocked model responses', async () => {
    let calls = 0;
    const manager = new RoomManager({ deepseek: { apiKey: 'test-only-key', transport: async (_, request) => {
      calls += 1;
      const actions = input(request).action_options;
      const best = actions.find((action) => action.action === 'call_3') ?? actions.find((action) => action.action === 'play') ?? actions[0];
      return response(JSON.stringify({ action_index: best.index }));
    } } });
    managers.push(manager);
    const room = manager.create({ players: [{ name: 'DeepSeek', kind: 'deepseek', seat: 0 }, { name: 'Bot 1', kind: 'greedy', seat: 1 }, { name: 'Bot 2', kind: 'greedy', seat: 2 }] });
    for (let step = 0; step < 300 && manager.getReplay(room.id).session.status !== 'finished'; step += 1) await manager.control(room.id, 'step');
    const replay = manager.getReplay(room.id);
    expect(replay.session.status).toBe('finished');
    expect(calls).toBeGreaterThan(1);
    expect(replay.turns.every((turn) => turn.source === 'agent')).toBe(true);
    expect(replay.accounting?.status).toBe('recorded');
    expect(replayJournal(manager.getJournal(room.id))).toEqual(replay.snapshots);
    expect(JSON.stringify(manager.getGameRecord(replay.accounting!.gameId))).not.toMatch(/test-only-key|Authorization|api_key|api_url/);
  });

  it('falls back for invalid model JSON rather than applying hallucinated actions', async () => {
    const manager = new RoomManager({ deepseek: { apiKey: 'test', transport: async () => response('{"action":"play","cards":["forged"]}') } });
    managers.push(manager);
    const room = manager.create({ players: [0, 1, 2].map((seat) => ({ name: 'DeepSeek ' + seat, kind: 'deepseek', seat })) });
    await manager.control(room.id, 'step');
    expect(manager.getReplay(room.id).turns[0]).toMatchObject({ source: 'fallback', reason: 'invalid', action: { type: 'call', score: 0 } });
  });

  it('cancels slow model calls at the configured deadline and records timeout fallback', async () => {
    let signal!: AbortSignal;
    const manager = new RoomManager({ deepseekTurnTimeoutMs: 10, deepseek: { apiKey: 'test', transport: (_credentials, _request, abortSignal) => {
      signal = abortSignal;
      return new Promise(() => undefined);
    } } });
    managers.push(manager);
    const room = manager.create({ players: [0, 1, 2].map((seat) => ({ name: 'DeepSeek ' + seat, kind: 'deepseek', seat })) });
    await manager.control(room.id, 'step');
    expect(signal.aborted).toBe(true);
    expect(manager.getReplay(room.id).turns[0]).toMatchObject({ source: 'fallback', reason: 'timeout', action: { type: 'call', score: 0 } });
    expect(manager.getReplay(room.id).turns[0]).not.toHaveProperty('modelResponse');
    expect(manager.getReplay(room.id).session.decision).toBeNull();
  });

  it('rejects custom DeepSeek destinations and invalid keys or configuration', () => {
    const manager = new RoomManager();
    managers.push(manager);
    expect(() => manager.create({ players: [{ name: 'AI', kind: 'deepseek', api_url: 'https://evil.example/steal', api_key: 'test' }] })).toThrow(/fixed/);
    expect(() => manager.create({ players: [{ name: 'AI', kind: 'deepseek', api_key: 'bad\nkey' }] })).toThrow(/API key/);
    expect(() => new RoomManager({ deepseekTurnTimeoutMs: 300001 })).toThrow(/timeout/);
    expect(() => new RoomManager({ deepseek: { model: 'deepseek-chat' as 'deepseek-flash' } })).toThrow(/model/);
  });

  it('serves recorded model responses through control, replay and journal endpoints without extra calls', async () => {
    let calls = 0;
    const server = createReplayServer({ deepseek: { apiKey: 'test-only-key', transport: async () => { calls += 1; return response('{"action_index":0}'); } } });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const post = (path: string, body: unknown) => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const room = await (await post('/api/rooms', { players: [0, 1, 2].map((seat) => ({ name: 'AI ' + seat, kind: 'deepseek', seat })) })).json();
      const base = '/api/rooms/' + room.id;
      const controlled = await (await post(base + '/control', { action: 'step' })).json();
      expect(controlled.turns[0].modelResponse).toMatchObject({ status: 'accepted', content: '{"action_index":0}' });
      for (const resource of ['replay', 'journal']) {
        const result = await (await fetch(origin + base + '/' + resource)).json();
        expect(result.turns[0].modelResponse).toEqual(controlled.turns[0].modelResponse);
        expect(JSON.stringify(result)).not.toContain('test-only-key');
      }
      expect(calls).toBe(1);
    } finally { await new Promise<void>((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections(); }); }
  });

  it('exposes safe HTTP configuration and refuses a model game before keys are supplied', async () => {
    const server = createReplayServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const post = async (path: string, body: unknown) => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const room = await (await post('/api/rooms', { players: [0, 1, 2].map((seat) => ({ name: 'DeepSeek ' + seat, kind: 'deepseek', seat })) })).json();
      expect(room.players.every((player: { hasApiKey: boolean }) => !player.hasApiKey)).toBe(true);
      expect((await post('/api/rooms/' + room.id + '/control', { action: 'start' })).status).toBe(409);
      const updated = await fetch(origin + '/api/rooms/' + room.id + '/players/' + room.players[0].id + '/api-key', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: 'test-only-key' }) });
      const safe = await updated.json();
      expect(updated.status).toBe(200);
      expect(safe.players[0].hasApiKey).toBe(true);
      expect(JSON.stringify(safe)).not.toContain('test-only-key');
      expect((await fetch(origin + '/deepseek')).status).toBe(200);
    } finally { await new Promise<void>((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections(); }); }
  });
});
