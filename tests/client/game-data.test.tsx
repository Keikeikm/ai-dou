import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AnalyticsPage from '../../client/components/AnalyticsPage.js';
import { App } from '../../client/App.js';
import { profileParameter } from '../../client/api/player-profile.js';
import { summarizeEpisode, summaryOnly, episodeSnapshots } from '../../server/data/episodes.js';
import { bluffEpisode } from '../data-fixture.js';
import type { DataResponse } from '../../shared/game-data.js';

const episode = summarizeEpisode(bluffEpisode());
function response(total = 1): DataResponse {
  return { total, limit: 12, offset: 0, active: 0, games: total ? [summaryOnly(episode)] : [], profiles: [{ id: 'human_local', name: '我', createdAt: 0 }], storage: { persistent: true, schemaVersion: 1 },
    overview: { total, finished: total, incomplete: 0, steps: episode.steps, humanSteps: 13, fallbackSteps: 0, gameCounts: { bluff: total, doudizhu: 0 }, distribution: { '如实出牌': 2, '吹牛出牌': 11, '相信': 13 },
      players: total ? episode.players.map((p) => ({ profileId: p.profileId, name: p.name, kind: p.kind, games: total, completed: total, wins: p.won ? total : 0, metrics: p.metrics, roles: {} })) : [], trend: total ? [{ day: '2026-11-01', games: total, completed: total, wins: total, actions: episode.steps }] : [] } };
}
function setup(data = response()) {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input); requests.push(path);
    if (path.includes('/overview')) { const params = new URL(path, 'http://localhost').searchParams; return new Response(JSON.stringify({ ...data, offset: Number(params.get('offset') ?? 0) })); }
    if (path.includes('/episodes/')) return new Response(JSON.stringify({ episode, snapshots: episodeSnapshots(episode) }));
    if (path === '/api/data/profiles' && init?.method === 'POST') { const name = JSON.parse(String(init.body)).name; const profile = { id: 'human_test', name, createdAt: 0 }; data.profiles.push(profile); return new Response(JSON.stringify(profile), { status: 201 }); }
    throw new Error('Unexpected request: ' + path);
  }));
  return requests;
}
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
describe('standalone data center', () => {
  it('routes to the data center without joining a room or invoking model APIs', async () => {
    const requests = setup(response(0)); render(<App route={{ kind: 'analytics' }} />);
    await screen.findByText('你的故事，从下一局开始。');
    expect(requests).toHaveLength(1); expect(requests[0]).toContain('/api/data/overview');
    expect(screen.queryByText('牌局档案 · 单局复盘')).toBeNull();
  });
  it('renders AVA charts, switches metrics and keeps exports tied to the current filters', async () => {
    setup(); render(<AnalyticsPage />); await screen.findByText('习惯，藏在每一次选择里');
    expect(screen.getByRole('img', { name: '日期与局分析图' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('批量指标'), { target: { value: 'distribution' } });
    expect(screen.getByRole('img', { name: '动作类别与次分析图' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('分析玩家'), { target: { value: 'human_local' } });
    await screen.findByText('我的胜率');
    const link = screen.getByRole('link', { name: '决策样本 JSONL ↓' }) as HTMLAnchorElement;
    expect(link.href).toContain('profileId=human_local'); expect(link.href).toContain('game=bluff'); expect(link.href).toContain('status=finished');
  });
  it('paginates archives independently of aggregate totals and resets the page on filtering', async () => {
    const requests = setup(response(30)); render(<AnalyticsPage />); await screen.findByText('共 30 局');
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(requests.at(-1)).toContain('offset=12'));
    await screen.findByText('13–24 / 30');
    fireEvent.change(screen.getByLabelText('对局状态'), { target: { value: '' } });
    await waitFor(() => { expect(requests.at(-1)).toContain('offset=0'); expect(requests.at(-1)).not.toContain('status='); });
  });
  it('creates a persistent player selection used by future game requests', async () => {
    setup(); render(<AnalyticsPage />); await screen.findByText('这局，你是谁？');
    fireEvent.change(screen.getByLabelText('新玩家名字'), { target: { value: '小林' } }); fireEvent.click(screen.getByRole('button', { name: '创建并使用' }));
    await waitFor(() => expect(profileParameter()).toEqual({ profileId: 'human_test' }));
    expect((screen.getByLabelText('下次开局身份') as HTMLSelectElement).value).toBe('human_test');
  });
  it('opens an archived Bluff replay and seeks through original actions', async () => {
    setup(); render(<AnalyticsPage />); await screen.findByRole('button', { name: '复盘 ↗' });
    fireEvent.click(screen.getByRole('button', { name: '复盘 ↗' })); await screen.findByText('初始发牌');
    fireEvent.click(screen.getByRole('button', { name: '下一步' })); expect(screen.getByText('我 · 出 4 张牌')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭详情' })); expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('shows a failed load with retry instead of invented statistics', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: '磁盘暂不可用' }), { status: 503 })));
    render(<AnalyticsPage />); await screen.findByRole('alert');
    expect(screen.getByText('磁盘暂不可用')).toBeTruthy(); expect(screen.queryByLabelText('多局统计')).toBeNull();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});
