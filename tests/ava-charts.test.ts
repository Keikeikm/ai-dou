import { afterEach, describe, expect, it } from 'vitest';
import { RoomManager } from '../server/rooms/room-manager.js';
import { ReplayChatService, type AnalysisCompletionRequest } from '../server/analysis/replay-chat.js';
import { avaChartLabels, buildAvaChart, chartSource, type AvaChartType } from '../shared/ava-charts.js';
import type { AnalysisScope } from '../shared/replay-chat.js';

const managers: RoomManager[] = [];
afterEach(() => { managers.splice(0).forEach((manager) => manager.dispose()); });
async function fixture() {
  const manager = new RoomManager({ stepIntervalMs: 0 }); managers.push(manager);
  const room = manager.create({ seed: 7, players: [0, 1, 2].map((seat) => ({ seat, name: 'Player ' + seat, kind: 'greedy' as const })) });
  for (let i = 0; i < 15; i++) await manager.control(room.id, 'step');
  const replay = manager.getReplay(room.id);
  const enriched = { ...replay, turns: replay.turns.map((turn, i) => ({ ...turn, modelResponse: { provider: 'deepseek' as const, model: 'test', status: 'accepted' as const,
    durationMs: i * 10, usage: { totalTokens: i === 1 ? undefined : i * 100 } } })) };
  const scope: AnalysisScope = { generation: 1, from: 0, to: 15, metric: 'duration', seat: 'all' };
  return { manager, replay: enriched, scope };
}
const completion = (content: string) => ({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });

describe('AVA complete visualization', () => {
  it.each(Object.keys(avaChartLabels) as AvaChartType[])('constructs real data for %s without accepting generated values or URLs', async (type) => {
    const { replay, scope } = await fixture();
    const categorical = ['pie', 'radar', 'word-cloud', 'venn', 'treemap', 'sankey'].includes(type);
    const hands = ['funnel', 'waterfall', 'liquid'].includes(type);
    const selected = { metric: categorical ? 'actions' as const : hands ? 'hands' as const : 'duration' as const, seat: hands ? 0 : 'all' as const };
    const range = hands ? { ...scope, from: 5 } : scope;
    const spec = buildAvaChart(replay, range, selected, type, { title: '<img src=x>', data: [{ value: 99999999 }], background: 'https://untrusted.example', innerRadius: 0.6 });
    expect(spec.chartType).toBe(type);
    expect(JSON.stringify(spec)).not.toContain('99999999');
    expect(JSON.stringify(spec)).not.toContain('https://untrusted.example');
    expect(JSON.stringify(spec)).not.toContain('<img');
  });

  it('pairs different metrics by player and step and excludes missing measurements', async () => {
    const { replay, scope } = await fixture();
    const spec = buildAvaChart(replay, scope, { metric: 'duration', seat: 'all', xMetric: 'duration', yMetric: 'tokens' }, 'scatter');
    const points = spec.config.data as { x: number; y: number }[];
    expect(points).toHaveLength(14);
    expect(points.every((point) => point.y === point.x * 10)).toBe(true);
    expect(points.some((point) => point.x === 0 && point.y === 0)).toBe(true);
  });

  it('uses the real AVA advisor/config generator with scoped data and accounts for all three model calls', async () => {
    const { replay, scope } = await fixture();
    const requests: AnalysisCompletionRequest[] = [];
    const key = 'synthetic-server-secret';
    const service = new ReplayChatService({ apiKey: key, transport: async (_credentials, request) => {
      requests.push(request);
      if (request.response_format) return completion(JSON.stringify({ answer: '比较耗时分布。', steps: [], chart: { metric: 'duration', seat: 'all', avaType: 'boxplot' } }));
      if (requests.length === 2) return completion('boxplot');
      return completion(JSON.stringify({ type: 'boxplot', title: key, data: [{ category: 'forged', value: 99999999 }], script: 'fetch("https://untrusted.example")' }));
    } });
    try {
      const result = await service.ask('test', replay, { question: '用箱线图比较耗时', scope: { ...scope, seat: 1 } }, new AbortController().signal);
      expect(requests).toHaveLength(3);
      expect(result.usage.totalTokens).toBe(450);
      expect(result.chart?.seat).toBe(1);
      expect(result.chart?.visualization?.chartType).toBe('boxplot');
      expect(result.chart?.visualization?.config.title).toBe('[已隐藏]');
      expect((result.chart?.visualization?.config.data as { category: string }[]).every((point) => point.category.includes('Player 1'))).toBe(true);
      const sent = JSON.stringify(requests);
      expect(sent).not.toContain(key); expect(sent).not.toContain('"seed"'); expect(sent).not.toContain('"bottomCards"'); expect(sent).not.toContain('"modelResponse"');
      expect(JSON.stringify(result)).not.toContain('99999999'); expect(JSON.stringify(result)).not.toContain('untrusted.example');
    } finally { service.dispose(); }
  });

  it('bounds the whole workflow even when the chart transport ignores cancellation', async () => {
    const { replay, scope } = await fixture();
    const service = new ReplayChatService({ apiKey: 'test-only', timeoutMs: 150, transport: async (_credentials, request) => request.response_format
      ? completion(JSON.stringify({ answer: '比较耗时', steps: [], chart: { metric: 'duration', seat: 'all' } })) : new Promise(() => {}) });
    try { await expect(service.ask('test', replay, { question: '绘制图表', scope }, new AbortController().signal)).rejects.toMatchObject({ statusCode: 504 }); }
    finally { service.dispose(); }
  });

  it('does not present aggregated category counts as a numeric distribution', async () => {
    const { replay, scope } = await fixture();
    expect(() => buildAvaChart(replay, scope, { metric: 'actions', seat: 'all' }, 'histogram')).toThrow('原始数值观测');
    expect(JSON.stringify(chartSource(replay, { ...scope, seat: 1 }, { metric: 'hands', seat: 1 }))).not.toContain('seed');
  });
});
