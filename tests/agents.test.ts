import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentProtocolError, createAgentRequest, parseAgentRequest, parseAgentResponse, type AgentRequest } from '../server/agents/protocol.js';
import { AgentEndpointPolicy, isPublicAgentAddress, normalizeApiKey, transportError } from '../server/agents/http.js';
import { createGame, callScore } from '../server/game/game.js';
import { cardsFromRanks } from '../server/game/cards.js';
import { applyGameAction } from '../server/game/actions.js';
import { RoomManager } from '../server/rooms/room-manager.js';
import { createReplayServer } from '../server/http/replay-server.js';
import { createExampleAgentServer, decideExampleRequest } from '../tools/example-agent.js';
import { replayJournal } from '../server/rooms/scheduler.js';

const servers: Server[] = [];
const managers: RoomManager[] = [];

describe('safe Agent transport diagnostics', () => {
  it.each([
    ['ENOTFOUND', 'dns', 'dns_failed'], ['ECONNRESET', 'connection', 'connection_failed'], ['EACCES', 'connection', 'connection_failed'],
    ['CERT_HAS_EXPIRED', 'connection', 'tls_failed'], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'connection', 'tls_failed'], ['ECONNRESET', 'response', 'response_failed'],
  ] as const)('classifies %s without exposing raw error messages', (code, phase, expected) => {
    const error = transportError({ code, message: 'test-only-secret vendor-body' }, new AbortController().signal, phase);
    expect(error.code).toBe(expected);
    expect(error.message).not.toMatch(/test-only-secret|vendor-body/);
  });
  it('distinguishes cancelled requests from transport failures', () => {
    const controller = new AbortController();
    controller.abort();
    expect(transportError({ code: 'EACCES' }, controller.signal, 'connection').code).toBe('cancelled');
  });
});
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections(); });
  }
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
}

async function remote(handler?: (input: AgentRequest, incoming: IncomingMessage, response: ServerResponse) => void) {
  const inputs: AgentRequest[] = [];
  const authorizations: (string | undefined)[] = [];
  const origin = await listen(createServer(async (incoming, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const input = parseAgentRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    inputs.push(input);
    authorizations.push(incoming.headers.authorization);
    if (handler) handler(input, incoming, response);
    else { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(decideExampleRequest(input))); }
  }));
  return { origin, url: origin + '/decide', inputs, authorizations };
}

function roomFor(origin: string, options: ConstructorParameters<typeof RoomManager>[0] = {}) {
  const manager = new RoomManager({ agentAllowedOrigins: [origin], turnTimeoutMs: 500, stepIntervalMs: 0, ...options });
  managers.push(manager);
  const players = [0, 1, 2].map((seat) => ({ id: 'http-' + seat, name: 'HTTP Agent ' + seat, kind: 'http' as const, seat, api_url: origin + '/decide', api_key: 'secret-' + seat }));
  return { manager, players, room: manager.create({ seed: 7, players }) };
}

function initialRequest() {
  return createAgentRequest(createGame(7), { roomId: 'room_0123456789ab', generation: 1, round: 1, deadline: Date.now() + 1500 });
}

describe('Agent protocol', () => {
  it('sends only the acting hand and public information, never the deal log or unrevealed bottom', () => {
    const state = createGame(7);
    const request = initialRequest();
    expect(parseAgentRequest(request)).toEqual(request);
    expect(request.hand_cards).toEqual(state.hands[0].map((card) => card.id));
    expect(request.visible_cards).toEqual({ seat_0: 17, seat_1: 17, seat_2: 17 });
    expect(request.history).toEqual([]);
    expect(request.bottom_cards).toEqual([]);
    expect(request.role).toBeNull();
    for (const card of [...state.hands[1], ...state.hands[2], ...state.bottomCards]) expect(JSON.stringify(request)).not.toContain('"' + card.id + '"');
    const playing = callScore(state, 0, 3);
    const next = createAgentRequest(playing, { roomId: request.room_id, generation: 1, round: 2, deadline: Date.now() + 1500 });
    expect(parseAgentRequest(next).history).toEqual([{ seat: 0, action: 'call', score: 3, cards: [] }]);
    expect(next.bottom_cards).toHaveLength(3);
    expect(next.role).toBe('landlord');
  });

  it.each([
    null, [], {}, { protocol_version: 2 }, { request_id: 'stale' }, { extra: 'not-public' },
    { seat: 3 }, { hand_cards: ['hearts-3', 'hearts-3'] }, { hand_cards: ['3'] },
    { visible_cards: { seat_0: 1, seat_1: 17, seat_2: 17 } },
    { history: [{ seat: 0, action: 'deal', cards: [] }] }, { deadline_at: 'tomorrow' },
    { last_play: { seat: 1, cards: ['hearts-3'] } }, { bottom_cards: ['hearts-3'] },
  ])('rejects malformed or private request context %j', (patch) => {
    const input = patch === null || Array.isArray(patch) || Object.keys(patch).length === 0 ? patch : { ...initialRequest(), ...patch };
    expect(() => parseAgentRequest(input)).toThrow(AgentProtocolError);
  });

  it.each([
    null, [], {}, { protocol_version: 2 }, { request_id: 'old-turn' }, { action: 'invalid' },
    { action: 'play', cards: ['hearts-3'] }, { action: 'call_3', cards: ['hearts-3'] },
    { api_key: 'do-not-echo' }, { cards: null },
  ])('rejects malformed response envelopes and wrong-phase decisions %j', (patch) => {
    const request = initialRequest();
    const value = patch === null || Array.isArray(patch) || Object.keys(patch).length === 0 ? patch : { protocol_version: 1, request_id: request.request_id, action: 'pass', ...patch };
    expect(() => parseAgentResponse(value, request, createGame(7))).toThrow(AgentProtocolError);
  });

  it('maps pass to no bid and sends pairs, triple attachments and airplanes through authoritative validation', () => {
    const calling = createGame(7);
    const request = initialRequest();
    expect(parseAgentResponse({ protocol_version: 1, request_id: request.request_id, action: 'pass' }, request, calling)).toEqual({ type: 'call', score: 0 });
    for (const ranks of [['3', '3'], ['4', '4', '4', '5', '5'], ['3', '3', '3', '4', '4', '4', '5', '6']]) {
      const hand = cardsFromRanks([...ranks, 'A']);
      const playing = { ...callScore(calling, 0, 3), hands: [hand, calling.hands[1], calling.hands[2]] as typeof calling.hands };
      const next = createAgentRequest(playing, { roomId: request.room_id, generation: 1, round: 2, deadline: Date.now() + 1500 });
      const action = parseAgentResponse({ protocol_version: 1, request_id: next.request_id, action: 'play', cards: hand.slice(0, -1).map((card) => card.id) }, next, playing);
      expect(applyGameAction(playing, 0, action).hands[0]).toHaveLength(1);
      expect(() => parseAgentResponse({ protocol_version: 1, request_id: next.request_id, action: 'play', cards: [hand[0].id, hand[0].id] }, next, playing)).toThrow();
      expect(() => parseAgentResponse({ protocol_version: 1, request_id: next.request_id, action: 'play', cards: ['joker-big'] }, next, playing)).toThrow(/outside/);
    }
  });

  it('ships valid machine-readable schemas with unique card IDs and strict action fields', () => {
    const request = JSON.parse(readFileSync(new URL('../protocol/agent-request.schema.json', import.meta.url), 'utf8'));
    const response = JSON.parse(readFileSync(new URL('../protocol/agent-response.schema.json', import.meta.url), 'utf8'));
    expect(request.additionalProperties).toBe(false);
    expect(request.$defs.cards.uniqueItems).toBe(true);
    expect(response.properties.action.enum).toEqual(['call_1', 'call_2', 'call_3', 'pass', 'play']);
    expect(response.then.required).toEqual(['cards']);
  });
});

describe('Agent endpoint and key safety', () => {
  it('requires an explicit origin allowlist and rejects credentials in URLs or unsafe HTTP', () => {
    expect(() => new AgentEndpointPolicy().validate('https://agent.example/decide')).toThrow(/allowlisted/);
    const policy = new AgentEndpointPolicy(['https://agent.example', 'http://127.0.0.1:8787']);
    expect(policy.validate('https://agent.example/decide')).toBe('https://agent.example/decide');
    for (const url of ['https://other.example/decide', 'http://agent.example/decide', 'https://user:secret@agent.example/decide', 'https://agent.example/decide?key=x', 'https://agent.example/decide#x', 'file:///tmp/decide', 'https://169.254.169.254/metadata']) {
      expect(() => policy.validate(url)).toThrow();
    }
    expect(() => new AgentEndpointPolicy(['https://agent.example/decide'])).toThrow(/origin/);
    for (const value of ['', 'with space', 'secret\r\nheader', '密钥', 'x'.repeat(2049)]) expect(() => normalizeApiKey(value)).toThrow();
    expect(normalizeApiKey(null)).toBeUndefined();
  });

  it.each(['0.0.0.0', '10.1.1.1', '127.0.0.1', '100.64.0.1', '172.16.0.1', '169.254.169.254', '192.168.1.1', '198.18.0.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2001:0db8::1', '3fff::1', '2002:7f00:1::'])('rejects non-public IP %s', (address) => {
    expect(isPublicAgentAddress(address)).toBe(false);
  });

  it('checks every resolved address and pins only public addresses or explicit loopback', async () => {
    const dns = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const policy = new AgentEndpointPolicy(['https://agent.example', 'http://localhost:8787'], dns as unknown as typeof lookup);
    const signal = new AbortController().signal;
    expect((await policy.resolve('https://agent.example/decide', signal)).address).toBe('93.184.216.34');
    expect(isPublicAgentAddress('2001:4860:4860::8888')).toBe(true);
    dns.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]);
    await expect(policy.resolve('https://agent.example/decide', signal)).rejects.toThrow(/prohibited/);
    dns.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(policy.resolve('https://agent.example/decide', signal)).rejects.toThrow(/prohibited/);
    expect((await policy.resolve('http://localhost:8787/decide', signal)).address).toBe('127.0.0.1');
    dns.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    await expect(policy.resolve('http://localhost:8787/decide', signal)).rejects.toThrow(/prohibited/);
  });
});

describe('HTTP Agents in live rooms', () => {
  it.each([7, 21, 42])('finishes a mixed room with no-key HTTP and built-in Agents for seed %i', async (seed) => {
    const agent = await remote();
    const manager = new RoomManager({ agentAllowedOrigins: [agent.origin], stepIntervalMs: 0 });
    managers.push(manager);
    const room = manager.create({ seed, players: [
      { name: 'No key HTTP', kind: 'http', api_url: agent.url },
      { name: 'Random', kind: 'random' },
      { name: 'Greedy', kind: 'greedy' },
    ] });
    for (let count = 0; count < 300 && manager.get(room.id).status !== 'finished'; count += 1) await manager.control(room.id, 'step');
    expect(manager.get(room.id).status).toBe('finished');
    expect(manager.getJournal(room.id).turns.every((turn) => turn.source === 'agent')).toBe(true);
    expect(agent.inputs.every((input) => input.seat === 0)).toBe(true);
    expect(agent.authorizations.every((value) => value === undefined)).toBe(true);
    expect(replayJournal(manager.getJournal(room.id))).toEqual(manager.getReplay(room.id).snapshots);
  });

  it('runs all three external Agents to completion with per-seat Bearer keys and verifiable replay', async () => {
    const agent = await remote();
    const { manager, room } = roomFor(agent.origin);
    for (let count = 0; count < 300 && manager.get(room.id).status !== 'finished'; count += 1) await manager.control(room.id, 'step');
    expect(manager.get(room.id).status).toBe('finished');
    const journal = manager.getJournal(room.id);
    expect(journal.turns.every((turn) => turn.source === 'agent')).toBe(true);
    expect(agent.inputs).toHaveLength(journal.turns.length);
    for (const [index, input] of agent.inputs.entries()) {
      expect(input.round).toBe(index + 1);
      expect(input.history).toHaveLength(index);
      expect(agent.authorizations[index]).toBe('Bearer secret-' + input.seat);
      expect(Date.parse(input.deadline_at)).toBeGreaterThan(0);
    }
    expect(replayJournal(journal)).toEqual(manager.getReplay(room.id).snapshots);
    const publicData = JSON.stringify([manager.get(room.id), manager.getReplay(room.id), journal]);
    for (const key of ['secret-0', 'secret-1', 'secret-2', '/decide', 'authorization', 'api_key']) expect(publicData).not.toContain(key);
    await manager.control(room.id, 'reset');
    await manager.control(room.id, 'step');
    expect(agent.inputs.at(-1)).toMatchObject({ generation: 2, round: 1 });
    expect(agent.inputs.at(-1)!.request_id).not.toBe(agent.inputs[0].request_id);
  });

  it('manages write-only keys before play and releases them on departure or closure', async () => {
    const agent = await remote();
    const { manager, room, players } = roomFor(agent.origin);
    expect(manager.join(room.id, players[0]).players).toHaveLength(3);
    expect(() => manager.join(room.id, { ...players[0], api_key: 'changed' })).toThrow(/conflict/);
    manager.updateApiKey(room.id, 'http-0', 'replacement');
    manager.updateApiKey(room.id, 'http-1', null);
    expect(manager.get(room.id).players[1].hasApiKey).toBe(false);
    await manager.control(room.id, 'step');
    expect(agent.authorizations[0]).toBe('Bearer replacement');
    expect(() => manager.updateApiKey(room.id, 'http-0', 'late')).toThrow(/before/);
    manager.close(room.id);
    expect(manager.get(room.id).players.every((player) => player.hasApiKey === false)).toBe(true);
    const waiting = manager.create();
    manager.join(waiting.id, players[0]);
    manager.leave(waiting.id, 'http-0');
    expect(() => manager.updateApiKey(waiting.id, 'http-0', 'removed')).toThrow(/not found/);
    expect(manager.get(waiting.id).players).toHaveLength(0);
  });

  it.each([
    ['bad JSON', 'invalid', (input: AgentRequest, response: ServerResponse) => { response.end('{'); }],
    ['stale id', 'invalid', (input: AgentRequest, response: ServerResponse) => { response.end(JSON.stringify({ protocol_version: 1, request_id: 'old', action: 'call_3' })); }],
    ['unknown fields', 'invalid', (input: AgentRequest, response: ServerResponse) => { response.end(JSON.stringify({ ...decideExampleRequest(input), api_key: 'secret-0' })); }],
    ['oversized JSON', 'invalid', (input: AgentRequest, response: ServerResponse) => { response.end(' '.repeat(16385)); }],
    ['wrong media type', 'invalid', (input: AgentRequest, response: ServerResponse) => { response.setHeader('Content-Type', 'text/plain'); response.end('{}'); }],
    ['unauthorized', 'error', (input: AgentRequest, response: ServerResponse) => { response.statusCode = 401; response.end('secret-0'); }],
    ['redirect', 'error', (input: AgentRequest, response: ServerResponse) => { response.statusCode = 302; response.setHeader('Location', 'http://169.254.169.254/'); response.end(); }],
    ['server failure', 'error', (input: AgentRequest, response: ServerResponse) => { response.statusCode = 500; response.end('secret-0'); }],
  ])('falls back once for %s without leaking response bodies or following redirects', async (_, reason, send) => {
    const agent = await remote((input, incoming, response) => { response.setHeader('Content-Type', 'application/json'); send(input, response); });
    const { manager, room } = roomFor(agent.origin);
    await manager.control(room.id, 'step');
    expect(manager.getJournal(room.id).turns[0]).toMatchObject({ source: 'fallback', reason, action: { type: 'call', score: 0 } });
    expect(agent.inputs).toHaveLength(1);
    expect(JSON.stringify(manager.getReplay(room.id))).not.toContain('secret-0');
  });

  it('intercepts legal-shaped but illegal plays and uses the same leading fallback', async () => {
    const agent = await remote((input, incoming, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ protocol_version: 1, request_id: input.request_id, action: input.action_type === 'call' ? 'call_3' : 'pass' }));
    });
    const { manager, room } = roomFor(agent.origin);
    await manager.control(room.id, 'step');
    await manager.control(room.id, 'step');
    expect(manager.getJournal(room.id).turns[1]).toMatchObject({ source: 'fallback', reason: 'invalid', action: { type: 'play' } });
    expect(replayJournal(manager.getJournal(room.id))).toEqual(manager.getReplay(room.id).snapshots);
  });

  it('times out the whole call, aborts the HTTP stream, and ignores a late response without retry', async () => {
    let received!: () => void;
    const arrived = new Promise<void>((resolveReceived) => { received = resolveReceived; });
    let response!: ServerResponse;
    const agent = await remote((input, incoming, outgoing) => { response = outgoing; received(); });
    const { manager, room } = roomFor(agent.origin, { turnTimeoutMs: 80 });
    const step = manager.control(room.id, 'step');
    await arrived;
    const closed = once(response, 'close');
    await step;
    await closed;
    response.end(JSON.stringify(decideExampleRequest(agent.inputs[0])));
    expect(manager.getJournal(room.id).turns).toHaveLength(1);
    expect(manager.getJournal(room.id).turns[0]).toMatchObject({ reason: 'timeout', action: { type: 'call', score: 0 } });
    expect(agent.inputs).toHaveLength(1);
  });

  it('pauses a pending HTTP call without committing fallback, then resumes the same turn', async () => {
    let arrived!: () => void;
    const received = new Promise<void>((resolveReceived) => { arrived = resolveReceived; });
    const agent = await remote((input, incoming, response) => {
      if (input.generation === 1 && !agent.authorizations.slice(0, -1).length) { arrived(); return; }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(decideExampleRequest(input)));
    });
    const { manager, room } = roomFor(agent.origin);
    const step = manager.control(room.id, 'step');
    await received;
    await manager.control(room.id, 'pause');
    await step;
    expect(manager.getJournal(room.id).turns).toHaveLength(0);
    await manager.control(room.id, 'step');
    expect(manager.getJournal(room.id).turns).toHaveLength(1);
    expect(agent.inputs[1].request_id).toBe(agent.inputs[0].request_id);
  });

  it('authenticates the runnable example and can finish a real three-Agent game', async () => {
    const origin = await listen(createExampleAgentServer('example-secret'));
    const response = await fetch(origin + '/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(initialRequest()) });
    expect(response.status).toBe(401);
    const { manager, room } = roomFor(origin);
    for (const player of manager.get(room.id).players) manager.updateApiKey(room.id, player.id, 'example-secret');
    for (let count = 0; count < 300 && manager.get(room.id).status !== 'finished'; count += 1) await manager.control(room.id, 'step');
    expect(manager.get(room.id).status).toBe('finished');
    expect(manager.getJournal(room.id).turns.every((turn) => turn.source === 'agent')).toBe(true);
  });

  it('provides write-only registration and key-management HTTP routes without exposing secrets via SSE or schemas', async () => {
    const agent = await remote();
    const origin = await listen(createReplayServer({ agentAllowedOrigins: [agent.origin], stepIntervalMs: 0 }));
    const request = async (path: string, body: unknown, method = 'POST') => fetch(origin + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const created = await (await request('/api/rooms', {})).json();
    const base = '/api/rooms/' + created.id;
    const player = { id: 'remote', name: 'Remote', kind: 'http', api_url: agent.url, api_key: 'never-echo' };
    const joined = await request(base + '/players', player);
    const publicText = await joined.text();
    expect(publicText).not.toContain('never-echo');
    expect(publicText).not.toContain(agent.url);
    expect((await request(base + '/players/remote/api-key', { api_key: 'new-key' }, 'PUT')).status).toBe(200);
    expect((await request(base + '/players/remote/api-key', {}, 'PUT')).status).toBe(400);
    expect((await request(base + '/players/remote/api-key', { api_key: 'new-key', extra: 1 }, 'PUT')).status).toBe(400);
    expect((await request(base + '/players/remote/api-key', { api_key: null }, 'PUT')).status).toBe(200);
    expect((await fetch(origin + base + '/players/remote/api-key')).status).toBe(405);
    const stream = await fetch(origin + base + '/events');
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).not.toContain('never-echo');
    await reader.cancel();
    for (const name of ['agent-request', 'agent-response']) {
      const schema = await (await fetch(origin + '/schemas/' + name + '.schema.json')).json();
      expect(schema.properties.protocol_version.const).toBe(1);
    }
    expect((await fetch(origin + '/agent-api')).status).toBe(200);
    for (const name of ['One', 'Two']) await request(base + '/players', { name, kind: 'greedy' });
    await request(base + '/control', { action: 'step' });
    expect((await request(base + '/players/remote/api-key', { api_key: 'late' }, 'PUT')).status).toBe(409);
  });
});
