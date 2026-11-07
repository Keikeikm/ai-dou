import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import AnalyticsPage from '../../client/components/AnalyticsPage.js';
import { createDeck } from '../../server/game/cards.js';
import { DataStore } from '../../server/data/store.js';
import { episodeSnapshots } from '../../server/data/episodes.js';
import { dataFilter } from '../../server/data/http.js';
import { BLACKJACK_RULES_VERSION } from '../../shared/blackjack.js';

const stores: DataStore[] = [];
afterEach(() => { cleanup(); for (const store of stores.splice(0)) store.close(); localStorage.clear(); vi.unstubAllGlobals(); });
function setup(natural = false) {
  const data = new DataStore(); stores.push(data);
  const remaining = createDeck().filter((card) => card.suit !== 'joker');
  const deck = (natural ? ['A', 'A', 'K', 'Q'] : ['10', '9', '8', '9']).map((rank) => remaining.splice(remaining.findIndex((card) => card.rank === rank), 1)[0]);
  data.save({ id: 'blackjack_ui_data_1', roomId: 'blackjack_ui_data', generation: 1, startedAt: 1000, status: 'finished',
    players: [{ profileId: 'human_local', name: '我', kind: 'human', identity: 'profile', seat: 0 }, { profileId: 'agent_whale', name: '鲸鱼娘', kind: 'deepseek', identity: 'agent', seat: 1 }],
    raw: { game: 'blackjack', rulesVersion: BLACKJACK_RULES_VERSION, deck: [...deck, ...remaining], steps: natural ? [] : [
      { seat: 0, action: { type: 'stand' }, source: 'human', at: 1001, durationMs: 0 },
      { seat: 1, action: { type: 'stand' }, source: 'model', at: 1002, durationMs: 10 },
    ] } });
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    requests.push(String(path)); expect(init?.method ?? 'GET').toBe('GET');
    const url = new URL(String(path), 'http://localhost');
    if (url.pathname === '/api/data/overview') return new Response(JSON.stringify(data.query(dataFilter(url))));
    if (url.pathname === '/api/data/episodes/blackjack_ui_data_1') { const episode = data.get('blackjack_ui_data_1')!; return new Response(JSON.stringify({ episode, snapshots: episodeSnapshots(episode) })); }
    throw new Error('Unexpected request ' + path);
  }));
  return requests;
}

it('filters 21 point games, labels ties, and replays private views without model calls', async () => {
  const requests = setup(); render(<AnalyticsPage />);
  await screen.findByText('你的故事，从下一局开始。');
  fireEvent.change(screen.getByLabelText('游戏'), { target: { value: 'blackjack' } });
  await screen.findByText('平局');
  expect(screen.getByRole('columnheader', { name: '要牌率' })).toBeTruthy();
  expect(screen.getByRole('columnheader', { name: '停牌率' })).toBeTruthy();
  expect(screen.getByRole('columnheader', { name: '平局率' })).toBeTruthy();
  expect((screen.getByRole('link', { name: '决策样本 JSONL ↓' }) as HTMLAnchorElement).href).toContain('game=blackjack');
  fireEvent.change(screen.getByLabelText('分析玩家'), { target: { value: 'human_local' } });
  await screen.findByText('0 胜 · 1 平 / 1 局完成');
  fireEvent.click(screen.getByRole('button', { name: '复盘 ↗' }));
  await screen.findByText('初始发牌');
  expect(screen.getByText(/双方平局/)).toBeTruthy();
  expect(screen.getByText('鲸鱼娘 · 暗牌未揭晓')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  expect(screen.getByText('我 · 停牌')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  expect(screen.getByText('鲸鱼娘 · 18 点')).toBeTruthy();
  await waitFor(() => expect(requests).toHaveLength(4));
  expect(requests.every((path) => path.startsWith('/api/data/'))).toBe(true);
});

it('shows zero-action natural ties without fabricated moves', async () => {
  setup(true); render(<AnalyticsPage />);
  await screen.findByText('你的故事，从下一局开始。');
  fireEvent.change(screen.getByLabelText('游戏'), { target: { value: 'blackjack' } });
  await screen.findByText('平局');
  fireEvent.click(screen.getByRole('button', { name: '复盘 ↗' }));
  await screen.findByText('初始发牌');
  expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: '上一步' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('全部动作 · 0 步')).toBeTruthy();
  expect(screen.getByText('鲸鱼娘 · 21 点')).toBeTruthy();
});
