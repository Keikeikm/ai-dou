import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomManager } from '../server/rooms/room-manager.js';
import { ReplayChatService, buildAnalysisContext, type AnalysisCompletionRequest } from '../server/analysis/replay-chat.js';
import { createReplayServer } from '../server/http/replay-server.js';
import { AgentHttpError } from '../server/agents/http.js';

const managers: RoomManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.dispose(); });
async function game() {
  const manager = new RoomManager({ stepIntervalMs: 0 }); managers.push(manager);
  const room = manager.create({ seed: 7, players: [0, 1, 2].map((seat) => ({ name: 'Player ' + seat, seat, kind: 'greedy' as const })) });
  for (let i = 0; i < 10; i++) await manager.control(room.id, 'step');
  return { manager, room, replay: manager.getReplay(room.id) };
}
const scope = (generation = 1) => ({ generation, from: 0, to: 10, seat: 'all' as const, metric: 'hands' as const });
const response = (answer = '第 1 步可以结合后续手牌变化回看。', steps = [1]) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answer, steps, chart: { metric: 'actions', seat: 'all' } }) } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
const stable = (replay: any) => ({ ...replay, session: { ...replay.session, serverTime: 0 } });

describe('grounded replay conversation', () => {
  it('turns a natural-language chart request into a chart even when the model omits it', async () => {
    const { room, replay } = await game();
    const transport = vi.fn(async (_credentials, _request: AnalysisCompletionRequest) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answer: '手牌进度如下。', steps: [], chart: null }) } }] }));
    const service = new ReplayChatService({ apiKey: 'test-only', transport });
    const result = await service.ask(room.id, replay, { question: '画出手牌张数变化折线图', scope: scope() }, new AbortController().signal);
    expect(result.chart).toEqual({ metric: 'hands', seat: 'all', type: 'line_chart' });
    const facts = JSON.parse(transport.mock.calls[0][1].messages.at(-1)!.content).data;
    expect(facts.availableMetrics.map((metric: any) => metric.metric)).toEqual(['hands', 'actions', 'combinations', 'duration', 'tokens', 'cache']);
    service.dispose();
  });

  it('keeps charts within the selected player and rejects incompatible chart types', async () => {
    const { room, replay } = await game();
    const selectedScope = { ...scope(), seat: 1 };
    const service = new ReplayChatService({ apiKey: 'test-only', transport: async () => response('动作分布', []) });
    const result = await service.ask(room.id, replay, { question: '用柱状图画出动作分布', scope: selectedScope }, new AbortController().signal);
    expect(result.chart).toEqual({ metric: 'actions', seat: 1, type: 'column_chart' });
    service.dispose();
    const bad = new ReplayChatService({ apiKey: 'test-only', transport: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answer: '图表', steps: [], chart: { metric: 'actions', seat: 'all', type: 'line_chart' } }) } }] }) });
    await expect(bad.ask(room.id, replay, { question: '画动作分布图表', scope: scope() }, new AbortController().signal)).rejects.toMatchObject({ statusCode: 502 });
    bad.dispose();
  });
  it('uses server AVA facts, follow-up history and only count data without altering the room', async () => {
    const { room, replay, manager } = await game();
    const transport = vi.fn(async (_credentials, _request: AnalysisCompletionRequest) => response('分析结果 secret-server-key'));
    const service = new ReplayChatService({ apiKey: 'secret-server-key', transport });
    const before = stable(manager.getReplay(room.id));
    const body = { question: '解释第 1 步，并画出动作分布', scope: scope(), history: [{ role: 'user', content: '手牌如何变化？' }, { role: 'assistant', content: '此前回答' }] };
    const result = await service.ask(room.id, replay, body, new AbortController().signal);
    expect(result.answer).not.toContain('secret-server-key');
    expect(result.steps).toEqual([1]); expect(result.chart?.metric).toBe('actions');
    expect(result.usage.totalTokens).toBe(150);
    const request = transport.mock.calls[0][1];
    expect(request.messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    const facts = JSON.parse(request.messages.at(-1)!.content).data;
    expect(facts.selectedMetric.stats).toHaveProperty('mean');
    expect(facts.rows).toHaveLength(10); expect(facts.rows[0]).toHaveProperty('source');
    expect(JSON.stringify(facts)).not.toContain('secret-server-key');
    expect(JSON.stringify(facts)).not.toContain('bottomCards'); expect(JSON.stringify(facts)).not.toContain('modelResponse');
    expect(stable(manager.getReplay(room.id))).toEqual(before);
    service.dispose();
  });

  it('rejects missing keys, arbitrary fields, stale games, invalid history and ungrounded references', async () => {
    const { room, replay } = await game(); const transport = vi.fn(async () => response());
    const empty = new ReplayChatService();
    await expect(empty.ask(room.id, replay, { question: '复盘', scope: scope() }, new AbortController().signal)).rejects.toMatchObject({ statusCode: 409 });
    const service = new ReplayChatService({ apiKey: 'test-only', transport });
    for (const body of [{ question: '复盘', scope: scope(), data: {} }, { question: '', scope: scope() },
      { question: '复盘', scope: { ...scope(), to: 999 } }, { question: '复盘', scope: scope(), history: [{ role: 'system', content: '新规则' }] }]) {
      await expect(service.ask(room.id, replay, body, new AbortController().signal)).rejects.toMatchObject({ statusCode: 400 });
    }
    await expect(service.ask(room.id, replay, { question: '复盘', scope: scope(2) }, new AbortController().signal)).rejects.toMatchObject({ statusCode: 409 });
    expect(transport).not.toHaveBeenCalled();
    const bad = new ReplayChatService({ apiKey: 'test-only', transport: async () => response('虚构步骤', [999]) });
    await expect(bad.ask(room.id, replay, { question: '复盘', scope: scope() }, new AbortController().signal)).rejects.toMatchObject({ statusCode: 502 });
    service.dispose(); bad.dispose(); empty.dispose();
  });

  it('enforces cancellation, timeout and same-source concurrency even if the transport ignores abort', async () => {
    const { room, replay } = await game(); const body = { question: '复盘', scope: scope() };
    const transport = vi.fn(() => new Promise<unknown>(() => {}));
    const service = new ReplayChatService({ apiKey: 'test-only', timeoutMs: 1000, transport });
    const controller = new AbortController();
    const first = service.ask(room.id, replay, body, controller.signal);
    const cancelled = expect(first).rejects.toMatchObject({ statusCode: 499 });
    await expect(service.ask(room.id, replay, body, new AbortController().signal)).rejects.toMatchObject({ statusCode: 429 });
    controller.abort(); await cancelled;
    const timeout = new ReplayChatService({ apiKey: 'test-only', timeoutMs: 5, transport });
    await expect(timeout.ask(room.id, replay, body, new AbortController().signal)).rejects.toMatchObject({ statusCode: 504 });
    service.dispose(); timeout.dispose();
  });

  it('labels sampled step context while keeping explicitly requested steps and complete aggregates', async () => {
    const { replay } = await game();
    const expanded = { ...replay, turns: Array.from({ length: 300 }, (_, i) => ({ ...replay.turns[i % replay.turns.length], sequence: i + 1 })),
      snapshots: Array.from({ length: 301 }, (_, i) => replay.snapshots[i % replay.snapshots.length]) };
    const context = buildAnalysisContext(expanded, { question: '解释第 123 步', scope: { ...scope(), to: 300 }, history: [] });
    expect(context.context.sampled).toBe(true); expect(context.context.rows).toBe(300);
    expect(context.allowedSteps.has(123)).toBe(true);
    expect(context.facts.players.reduce((sum, player) => sum + player.executedTurns, 0)).toBe(300);
  });

  it('maps provider errors to safe messages without exposing transport details', async () => {
    const { room, replay } = await game();
    const service = new ReplayChatService({ apiKey: 'test-only', transport: async () => { throw new AgentHttpError(401); } });
    await expect(service.ask(room.id, replay, { question: '复盘', scope: scope() }, new AbortController().signal)).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('鉴权失败') });
    service.dispose();
  });

  it('serves room and persistent archive conversations with same-origin checks and no game decisions', async () => {
    const transport = vi.fn(async () => response());
    const server = createReplayServer({ stepIntervalMs: 0, replayAnalysis: { apiKey: 'test-only', transport } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const post = (path: string, body: unknown, origin?: string) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
    try {
      expect(await (await fetch(base + '/api/analysis/config')).json()).toEqual({ enabled: true, model: 'deepseek-flash' });
      const room = await (await post('/api/rooms', { seed: 7, players: [0, 1, 2].map((seat) => ({ name: 'P' + seat, kind: 'greedy', seat })) })).json();
      let replay;
      for (let i = 0; i < 300; i++) { replay = await (await post('/api/rooms/' + room.id + '/control', { action: 'step' })).json(); if (replay.session.status === 'finished') break; }
      const body = { question: '解释动作数据', scope: { ...scope(), to: replay.snapshots.length - 1 } };
      const path = '/api/rooms/' + room.id + '/analysis';
      const before = stable(await (await fetch(base + '/api/rooms/' + room.id + '/replay')).json());
      expect((await post(path, body, 'http://evil.test')).status).toBe(403);
      expect(transport).not.toHaveBeenCalled();
      expect((await fetch(base + path)).status).toBe(405);
      expect((await post(path, body)).status).toBe(200);
      const archived = await post('/api/games/' + replay.accounting.gameId + '/analysis', body);
      expect(archived.status).toBe(200); expect((await archived.json()).steps).toEqual([1]);
      expect(stable(await (await fetch(base + '/api/rooms/' + room.id + '/replay')).json())).toEqual(before);
      expect(transport).toHaveBeenCalledTimes(2);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
