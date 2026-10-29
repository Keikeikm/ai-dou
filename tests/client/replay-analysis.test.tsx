import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analysisCsv, analysisDataset, analysisRows, type AnalysisDataset } from '../../client/domain/replay-analysis.js';
import { runAvaAnalysis } from '../../client/domain/ava-analysis.js';
import ReplayAnalysis from '../../client/components/ReplayAnalysis.js';
import { App } from '../../client/App.js';
import type { Replay } from '../../client/domain/types.js';
import { fixture } from './fixture.js';

const games: ReturnType<typeof fixture>[] = [];
afterEach(() => { cleanup(); for (const game of games.splice(0)) game.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const setup = () => { const game = fixture(); games.push(game); return game; };
const cloneReplay = (game: ReturnType<typeof fixture>) => structuredClone(game.replay()) as Replay;

describe('AVA replay analytics', () => {
  it('uses snapshots for hand counts, includes bottom cards, and filters steps and seats', async () => {
    const game = setup(); await game.finish();
    const replay = cloneReplay(game);
    const startPlaying = replay.snapshots.findIndex((snapshot) => snapshot.phase === 'playing');
    const landlord = replay.snapshots[startPlaying].landlord;
    const data = analysisDataset(replay, 'hands', landlord, startPlaying, startPlaying);
    expect(data.points).toHaveLength(1);
    expect(data.points[0].y).toBe(20);
    expect(data.points[0].steps).toEqual([startPlaying]);
    const range = analysisDataset(replay, 'hands', 'all', 1, 3);
    expect(range.points).toHaveLength(9);
    expect(range.points.every((point) => Number(point.x) >= 1 && Number(point.x) <= 3)).toBe(true);
    const last = replay.snapshots.length - 1;
    expect(analysisDataset(replay, 'hands', 'all', last, last).points.some((point) => point.y === 0)).toBe(true);
    const actions = analysisDataset(replay, 'actions', 'all', 0, last);
    expect(actions.points.reduce((sum, point) => sum + point.y, 0)).toBe(replay.turns.length);
    expect(actions.points.flatMap((point) => point.steps).sort((a, b) => a - b)).toEqual(replay.turns.map((_, i) => i + 1));
    const combos = analysisDataset(replay, 'combinations', 'all', 0, last);
    expect(combos.points.reduce((sum, point) => sum + point.y, 0)).toBe(replay.turns.filter((turn) => turn.action.type === 'play').length);
  });

  it('keeps missing measurements distinct from zero, including old, human and fallback turns', async () => {
    const game = setup(); for (let i = 0; i < 4; i++) await game.manager.control(game.room.id, 'step');
    const replay = cloneReplay(game);
    replay.turns = replay.turns.map((turn, i) => i === 0 ? { ...turn, source: 'human', decisionKind: 'human' }
      : i === 1 ? { ...turn, modelResponse: { provider: 'deepseek', model: 'test', status: 'accepted', durationMs: 0, usage: { totalTokens: 0, promptTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 } } }
      : i === 2 ? { ...turn, source: 'fallback', reason: 'invalid', modelResponse: { provider: 'deepseek', model: 'test', status: 'invalid', durationMs: 100, usage: { totalTokens: 50, promptTokens: 10, cacheHitTokens: 8, cacheMissTokens: 2 } } }
      : { ...turn, modelResponse: { provider: 'deepseek', model: 'test', status: 'accepted', durationMs: 200, usage: { promptTokens: 10, cacheHitTokens: 8, cacheMissTokens: 3 } } });
    const rows = analysisRows(replay);
    expect(rows[0].source).toBe('真人操作'); expect(rows[0].duration).toBeNull();
    expect(rows[2].source).toContain('系统托管');
    const tokens = analysisDataset(replay, 'tokens', 'all', 0, 4);
    expect(tokens.observations).toBe(3); expect(tokens.missing).toBe(1);
    expect(tokens.points.map((point) => point.y)).toEqual([0, 50]);
    const cache = analysisDataset(replay, 'cache', 'all', 0, 4);
    expect(cache.missing).toBe(2); expect(cache.points.map((point) => point.y)).toEqual([80]);
    expect(rows[3].cache).toBeNull();
  });

  it('runs the real AVA data, advisor and insight modules without a model call', () => {
    const dataset: AnalysisDataset = { metric: 'duration', categorical: false, xLabel: '步骤', yLabel: 'ms', observations: 8, missing: 0,
      points: [10, 11, 12, 10, 11, 12, 10, 1000].map((y, i) => ({ x: i + 1, y, series: '玩家', steps: [i + 1] })) };
    const result = runAvaAnalysis(dataset);
    expect(result.errors).toEqual([]);
    expect(result.stats).toEqual({ mean: 134.5, min: 10, max: 1000 });
    expect(result.recommendations.some((advice) => advice.type === 'scatter_plot')).toBe(true);
    expect(result.insights.some((insight) => insight.text.includes('离群值') && insight.steps[0] === 8)).toBe(true);
    const hands = runAvaAnalysis({ ...dataset, metric: 'hands', points: [8, 7, 6, 5, 4, 3, 2, 1].map((y, i) => ({ x: i, y, series: '玩家', steps: [i] })) });
    expect(hands.insights.some((insight) => insight.text.includes('显著下降'))).toBe(true);
    const categories = runAvaAnalysis({ ...dataset, metric: 'actions', categorical: true,
      points: ['叫分', '出牌', '不出'].map((x, i) => ({ x, y: [1, 12, 3][i], series: '玩家', steps: [i + 1] })) });
    expect(categories.errors).toEqual([]);
    expect(categories.recommendations.some((advice) => advice.type === 'column_chart')).toBe(true);
    expect(runAvaAnalysis({ ...dataset, points: [] }).stats).toBeNull();
  });

  it('exports safe quoted CSV with empty missing fields and filtered data', async () => {
    const game = setup(); await game.manager.control(game.room.id, 'step');
    const row = analysisRows(cloneReplay(game))[0];
    const csv = analysisCsv([{ ...row, player: '=HYPERLINK("bad")', duration: null }]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"\'=HYPERLINK(""bad"")"');
    expect(csv).toContain('"","",""');
    const create = vi.fn(() => 'blob:test'); const revoke = vi.fn();
    vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<ReplayAnalysis replay={cloneReplay(game)} index={1} seek={vi.fn()} />);
    fireEvent.click(screen.getByText('查看数据表与逐步回看'));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: '导出筛选数据 CSV' }));
    expect(create).toHaveBeenCalledOnce(); expect(click).toHaveBeenCalledOnce();
    vi.runOnlyPendingTimers(); expect(revoke).toHaveBeenCalledWith('blob:test');
  });

  it('supports player/range filters, empty model metrics, and keyboard chart inspection', async () => {
    const game = setup(); await game.finish();
    const replay = cloneReplay(game); const seek = vi.fn();
    render(<ReplayAnalysis replay={replay} index={3} seek={seek} />);
    const details = [...document.querySelectorAll('details')];
    expect(details.every((section) => !section.open)).toBe(true);
    expect(document.querySelector('.replay-analysis > .analysis-chat')).toBeTruthy();
    fireEvent.click(screen.getByText(/调整分析范围与指标/));
    fireEvent.click(screen.getByText('手动图表与统计摘要'));
    fireEvent.change(screen.getByLabelText('分析玩家'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('回合范围'), { target: { value: 'current' } });
    expect(screen.getByLabelText('分析摘要').textContent).toContain('0–3 步');
    const chart = screen.getByRole('img', { name: /分析图/ });
    const points = chart.querySelectorAll('[role="button"]'); expect(points).toHaveLength(4);
    fireEvent.keyDown(points[0], { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: '回看第 0 步' })); expect(seek).toHaveBeenCalledWith(0);
    fireEvent.change(screen.getByLabelText('回合范围'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('起始步骤'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('结束步骤'), { target: { value: '3' } });
    expect(screen.getByLabelText('分析摘要').textContent).toContain('2–3 步');
    fireEvent.change(screen.getByLabelText('分析指标'), { target: { value: 'tokens' } });
    expect(screen.getByText(/当前范围没有可分析的模型 Token/)).toBeTruthy();
    expect(game.requests.map((request) => request.path)).toEqual(['/api/analysis/config']);
  });

  it('opens analysis from room and archive routes, and seeks locally without POSTs or Agent calls', async () => {
    const game = setup(); await game.finish();
    const gameId = game.manager.get(game.room.id).gameId;
    render(<App route={{ kind: 'archive', id: gameId }} />);
    await screen.findByText('归档回放 · 只读');
    fireEvent.click(screen.getByRole('button', { name: '复盘分析' }));
    const panel = await screen.findByRole('region', { name: 'AVA 复盘分析' }, { timeout: 5000 });
    fireEvent.click(within(panel).getByText('查看数据表与逐步回看'));
    fireEvent.click(within(panel).getByRole('button', { name: '第 1 步' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/1 \/ /)).toBeTruthy();
    expect(game.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(game.calls()).toBe(0);
    cleanup();
    render(<App route={{ kind: 'room', id: game.room.id }} />);
    await screen.findByRole('main', { name: '三人斗地主牌桌' });
    fireEvent.click(screen.getByRole('button', { name: '回放与日志' }));
    fireEvent.click(screen.getByRole('button', { name: '打开 AVA 复盘分析' }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'AVA 复盘分析' })).toBeTruthy());
    expect(game.requests.every((request) => request.method === 'GET')).toBe(true);
  });
});
