import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalysisChat } from '../../client/components/AnalysisChat.js';
import type { AnalysisChatReply } from '../../shared/replay-chat.js';
import { fixture } from './fixture.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const scope = { generation: 1, from: 0, to: 10, seat: 'all' as const, metric: 'hands' as const };
const reply: AnalysisChatReply = { answer: '<img onerror="bad"> 数据说明', steps: [2], chart: { metric: 'actions', seat: 'all' }, scope, model: 'deepseek-flash',
  usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 }, context: { rows: 10, includedRows: 10, sampled: false } };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

describe('replay conversation controls', () => {
  it('renders a chart inside the answer automatically and retains its range across filter changes', async () => {
    const game = fixture();
    try {
      for (let i = 0; i < 10; i++) await game.manager.control(game.room.id, 'step');
      const replay = game.replay();
      const chartReply: AnalysisChatReply = { ...reply, chart: { metric: 'hands', seat: 1, type: 'line_chart' }, scope: { ...scope, from: 2, to: 4 } };
      vi.stubGlobal('fetch', vi.fn(async (path: string) => json(path.endsWith('/config') ? { enabled: true, model: 'deepseek-flash' } : chartReply)));
      const seek = vi.fn(), showChart = vi.fn();
      const props = { replay, source: { kind: 'room' as const, id: game.room.id }, scope: chartReply.scope, seek, showChart };
      const view = render(<AnalysisChat {...props} />);
      await waitFor(() => expect((screen.getByLabelText('复盘问题') as HTMLTextAreaElement).disabled).toBe(false));
      fireEvent.change(screen.getByLabelText('复盘问题'), { target: { value: '画出手牌张数变化折线图' } });
      fireEvent.click(screen.getByRole('button', { name: '发送提问' }));
      const region = await screen.findByRole('region', { name: '回答图表 · 手牌张数变化' });
      const chart = within(region).getByRole('img', { name: /分析图/ });
      expect(chart.querySelectorAll('polyline')).toHaveLength(1);
      expect(chart.querySelectorAll('[role="button"]')).toHaveLength(3);
      expect(showChart).not.toHaveBeenCalled();
      fireEvent.click(chart.querySelector('[role="button"]')!);
      fireEvent.click(within(region).getByRole('button', { name: '回看第 2 步' }));
      expect(seek).toHaveBeenCalledWith(2);
      view.rerender(<AnalysisChat {...props} scope={{ ...scope, from: 0, to: 10 }} />);
      expect(chart.querySelectorAll('[role="button"]')).toHaveLength(3);
    } finally { game.dispose(); }
  });

  it('calls the model only on sending, supports follow-ups, escaped answers, references and suggested charts', async () => {
    const requests: { path: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit = {}) => {
      requests.push({ path, body: options.body ? JSON.parse(String(options.body)) : null });
      return json(path.endsWith('/config') ? { enabled: true, model: 'deepseek-flash' } : reply);
    }));
    const seek = vi.fn(), showChart = vi.fn();
    render(<AnalysisChat source={{ kind: 'archive', id: 'game_000000000000_1' }} scope={scope} seek={seek} showChart={showChart} />);
    await waitFor(() => expect((screen.getByLabelText('复盘问题') as HTMLTextAreaElement).disabled).toBe(false));
    expect(requests).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('复盘问题'), { target: { value: '解释出牌分布' } });
    fireEvent.click(screen.getByRole('button', { name: '发送提问' }));
    await screen.findByText(reply.answer);
    expect(document.querySelector('.analysis-answer img')).toBeNull();
    expect(requests[1].path).toBe('/api/games/game_000000000000_1/analysis');
    expect(requests[1].body.scope).toEqual(scope); expect(requests[1].body.history).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '回看第 2 步' })); expect(seek).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByRole('button', { name: '查看建议图表 · 动作分布' })); expect(showChart).toHaveBeenCalledWith(reply.chart, scope);
    fireEvent.change(screen.getByLabelText('复盘问题'), { target: { value: '继续解释' } });
    fireEvent.click(screen.getByRole('button', { name: '发送提问' }));
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2].body.history).toEqual([{ role: 'user', content: '解释出牌分布' }, { role: 'assistant', content: reply.answer }]);
  });

  it('cancels a pending request, prevents repeated sends, and keeps failed questions editable', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn((path: string, options: RequestInit = {}) => {
      if (path.endsWith('/config')) return Promise.resolve(json({ enabled: true, model: 'deepseek-flash' }));
      calls++;
      return new Promise<Response>((_, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }));
    }));
    render(<AnalysisChat source={{ kind: 'room', id: 'room_000000000000' }} scope={scope} seek={vi.fn()} showChart={vi.fn()} />);
    await waitFor(() => expect((screen.getByLabelText('复盘问题') as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('复盘问题'), { target: { value: '分析手牌' } });
    const button = screen.getByRole('button', { name: '发送提问' });
    await act(async () => { fireEvent.click(button); fireEvent.click(button); });
    expect(calls).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: '取消提问' }));
    await screen.findByText('已取消本次提问。');
    expect((screen.getByLabelText('复盘问题') as HTMLTextAreaElement).value).toBe('分析手牌');
    expect((screen.getByRole('button', { name: '发送提问' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows missing configuration and never starts a paid request automatically', async () => {
    const fetch = vi.fn(async () => json({ enabled: false, model: 'deepseek-flash' })); vi.stubGlobal('fetch', fetch);
    render(<AnalysisChat source={{ kind: 'room', id: 'room_000000000000' }} scope={scope} seek={vi.fn()} showChart={vi.fn()} />);
    await screen.findByText(/请配置服务端 DEEPSEEK_API_KEY/);
    expect((screen.getByRole('button', { name: '发送提问' }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
