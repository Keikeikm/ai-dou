import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../client/App.js';
import { fixture } from './fixture.js';

const games: ReturnType<typeof fixture>[] = [];
afterEach(() => { cleanup(); for (const game of games.splice(0)) game.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const setup = (options: Parameters<typeof fixture>[0] = {}) => { const game = fixture(options); games.push(game); return game; };
async function mount(game: ReturnType<typeof fixture>) {
  render(<App route={{ kind: 'room', id: game.room.id }} />);
  await screen.findByRole('main', { name: '三人斗地主牌桌' });
}

describe('React spectator application', () => {
  it('shows a creation-only homepage without subscribing to a game or invoking a model', async () => {
    const game = setup();
    render(<App route={{ kind: 'home' }} />);
    await waitFor(() => expect((screen.getByRole('button', { name: 'AI对战' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole('main', { name: '游戏大厅' })).toBeTruthy();
    expect(game.requests.map((request) => request.path)).toEqual(['/api/config']);
    expect(game.sources).toHaveLength(0);
    expect(game.calls()).toBe(0);
    expect(document.body.textContent).not.toContain('种子');
  });

  it('creates an AI room without sending a seed or starting decisions', async () => {
    const game = setup();
    const navigate = vi.fn();
    render(<App route={{ kind: 'home' }} navigate={navigate} />);
    await waitFor(() => expect((screen.getByRole('button', { name: 'AI对战' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'AI对战' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    const request = game.requests.find((request) => request.path === '/api/rooms')!;
    expect(request.body).not.toHaveProperty('seed');
    expect(request.body.players).toHaveLength(3);
    expect((request.body.players as { kind: string }[]).map((player) => player.kind)).toEqual(['deepseek', 'deepseek', 'deepseek']);
    expect((request.body.players as { skill: string }[]).map((player) => player.skill)).toEqual(['structure', 'tempo', 'teamwork']);
    expect(game.calls()).toBe(0);
  });

  it('keeps stale backends from creating fixed-deal rooms', async () => {
    const game = setup({ oldBackend: true });
    render(<App route={{ kind: 'home' }} />);
    await screen.findByText(/旧版后端/);
    expect((screen.getByRole('button', { name: 'AI对战' }) as HTMLButtonElement).disabled).toBe(true);
    expect(game.requests.some((request) => request.path === '/api/rooms')).toBe(false);
  });

  it('shows all AI hands by default, character artwork and hidden bidding bottom cards', async () => {
    const game = setup();
    await mount(game);
    expect(screen.getAllByRole('img', { name: /Q版角色/ })).toHaveLength(3);
    expect(screen.getAllByRole('img', { name: '未公开的底牌' })).toHaveLength(3);
    const hands = document.querySelectorAll('.hand-area');
    expect([...hands].map((hand) => hand.querySelectorAll('.card').length)).toEqual([17, 17, 17]);
    expect([...hands].map((hand) => hand.querySelectorAll('.card:not(.back)').length)).toEqual([17, 17, 17]);
    expect(document.querySelectorAll('.hand-area .back.joker, .hand-area .back.red')).toHaveLength(0);
    expect(screen.getByText('下一行动方')).toBeTruthy();
    expect(game.calls()).toBe(0);
  });

  it('uses local historical navigation without pausing or resetting the shared game', async () => {
    const game = setup();
    await game.manager.control(game.room.id, 'step');
    await mount(game);
    fireEvent.click(screen.getByRole('button', { name: '出牌记录' }));
    fireEvent.click(screen.getByRole('button', { name: '第 0 步 · 初始发牌' }));
    expect(screen.getByText('历史回看')).toBeTruthy();
    await act(async () => { await game.manager.control(game.room.id, 'step'); });
    expect(screen.getByRole('button', { name: '第 0 步 · 初始发牌' }).getAttribute('aria-current')).toBe('step');
    fireEvent.click(screen.getByRole('button', { name: '返回实时' }));
    expect(document.querySelector('[aria-current="step"]')?.textContent).toContain('02');
    expect(game.requests.some((request) => request.path.endsWith('/control'))).toBe(false);
  });

  it('randomizes every UI restart while preserving room and score identities', async () => {
    const game = setup();
    await mount(game);
    const before = game.replay();
    fireEvent.click(screen.getByRole('button', { name: '随机新局' }));
    await waitFor(() => expect(game.replay().generation).toBe(2));
    expect(game.replay().snapshots[0].hands).not.toEqual(before.snapshots[0].hands);
    expect(game.replay().room.players.map((player) => player.id)).toEqual(before.room.players.map((player) => player.id));
    expect(game.requests.find((request) => request.path.endsWith('/control'))?.body.action).toBe('new-game');
  });

  it('disables model start controls when configured seats have no key', async () => {
    const game = setup({ model: true, noKey: true });
    await mount(game);
    expect((screen.getByRole('button', { name: '开始观战' }) as HTMLButtonElement).disabled).toBe(true);
    expect(game.calls()).toBe(0);
  });

  it('opens failed model details and never renders an invalid response as executable HTML', async () => {
    const game = setup({ model: true, failure: '<img id="injected" onerror="alert(1)">' });
    await game.manager.control(game.room.id, 'step');
    await mount(game);
    fireEvent.click(screen.getByRole('button', { name: '查看托管详情' }));
    const response = screen.getByText(/<img id="injected"/);
    expect(response.tagName).toBe('PRE');
    expect(document.getElementById('injected')).toBeNull();
    expect(document.querySelector('.model-response-panel')?.hasAttribute('open')).toBe(true);
    expect(document.body.textContent).toContain('回复格式不符合协议');
  });

  it.each([[401, '鉴权失败'], [402, '账户余额不足'], [429, '请求限流']])('explains safe HTTP %s failures instead of only generic fallback', async (status, message) => {
    const game = setup({ model: true, status });
    await game.manager.control(game.room.id, 'step');
    await mount(game);
    expect(document.body.textContent).toContain(message);
    expect(document.body.textContent).not.toContain('test-only-shared-key');
  });

  it('cancels subscriptions on unmount without changing the shared room status', async () => {
    const game = setup();
    await mount(game);
    cleanup();
    expect(game.sources.every((source) => source.closed)).toBe(true);
    expect(game.replay().session.status).toBe('idle');
  });

  it('clears the old cache when switching rooms and only subscribes to the selected room', async () => {
    const game = setup();
    const second = game.manager.create({ players: [0, 1, 2].map((seat) => ({ name: 'Other ' + seat, kind: 'greedy', seat })) });
    const { rerender } = render(<App route={{ kind: 'room', id: game.room.id }} />);
    await waitFor(() => expect(screen.getByRole('main', { name: '三人斗地主牌桌' }).getAttribute('data-room-id')).toBe(game.room.id));
    rerender(<App route={{ kind: 'room', id: second.id }} />);
    await waitFor(() => expect(screen.getByRole('main', { name: '三人斗地主牌桌' }).getAttribute('data-room-id')).toBe(second.id));
    expect(game.sources[0].closed).toBe(true);
    expect(game.sources.at(-1)?.url).toContain(second.id);
    expect(screen.queryByText(game.room.id)).toBeNull();
  });

  it('keeps archived replay read-only and does not query keys or call Agents again', async () => {
    const game = setup({ model: true });
    await game.finish();
    const calls = game.calls();
    const gameId = game.manager.get(game.room.id).gameId;
    render(<App route={{ kind: 'archive', id: gameId }} />);
    await screen.findByText('归档回放 · 只读');
    fireEvent.click(screen.getByRole('button', { name: '出牌记录' }));
    expect(screen.queryByRole('button', { name: '随机新局' })).toBeNull();
    expect(game.requests.map((request) => request.path)).toEqual(['/api/games/' + gameId + '/replay']);
    fireEvent.click(screen.getByRole('button', { name: /第 1 步/ }));
    expect(document.querySelector('pre')?.textContent).toBe('{"action_index":0}');
    expect(game.calls()).toBe(calls);
  });

  it('shows waiting seats and registers an Agent while clearing unsent keys', async () => {
    const game = setup({ waiting: true });
    await mount(game);
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.change(screen.getByLabelText('策略'), { target: { value: 'deepseek' } });
    fireEvent.change(screen.getByLabelText('打牌 skill'), { target: { value: 'teamwork' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'test-only-seat-key' } });
    fireEvent.click(screen.getByRole('button', { name: '加入房间' }));
    await waitFor(() => expect(game.manager.get(game.room.id).players).toHaveLength(1));
    expect(game.manager.get(game.room.id).players[0].skill).toBe('teamwork');
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('');
    expect(document.body.textContent).not.toContain('test-only-seat-key');
  });

  it('requires explicit confirmation for a single connection test and never advances the room', async () => {
    const game = setup({ model: true });
    await mount(game);
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByText('Agent 密钥管理与测试 · 仅开局前可操作'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: '测试一次 DeepSeek 连接' }));
    expect(game.calls()).toBe(0);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '测试一次 DeepSeek 连接' }));
    await screen.findByText(/连接验证成功/);
    expect(game.calls()).toBe(1);
    expect(game.replay().turns).toHaveLength(0);
    expect(game.replay().accounting).toBeNull();
    confirm.mockRestore();
  });

  it('keeps settings and history off the default table and restores focus when closing a drawer', async () => {
    const game = setup();
    await mount(game);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByLabelText('Agent 入座')).toBeNull();
    expect(screen.queryByRole('navigation', { name: '历史步骤' })).toBeNull();
    const trigger = screen.getByRole('button', { name: '模型返回' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: '模型返回' })).toBeTruthy();
    expect(document.querySelector('.model-response-panel')?.hasAttribute('open')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(game.calls()).toBe(0);
  });

  it('flips non-acting hands with keyboard input without sending any game command', async () => {
    const game = setup({ model: true });
    await mount(game);
    const user = userEvent.setup();
    const count = game.requests.length;
    const seat = document.querySelector('.seat-2')!;
    const button = screen.getByRole('button', { name: '盖住鲸鱼娘的手牌' });
    button.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: '翻开鲸鱼娘的手牌' }).getAttribute('aria-pressed')).toBe('false');
    expect(seat.querySelectorAll('.hand-area .card.back')).toHaveLength(17);
    await user.keyboard(' ');
    expect(seat.querySelectorAll('.hand-area .card:not(.back)')).toHaveLength(17);
    expect(game.requests).toHaveLength(count);
    expect(game.calls()).toBe(0);
    expect(game.replay().turns).toHaveLength(0);
  });

  it('follows the acting hand across turns and history while preserving explicit spectator choices', async () => {
    const game = setup({ model: true });
    await mount(game);
    fireEvent.click(screen.getByRole('button', { name: '盖住鲸鱼娘的手牌' }));
    await act(async () => { await game.manager.control(game.room.id, 'step'); });
    const counts = () => [...document.querySelectorAll('.hand-area')].map((hand) => hand.querySelectorAll('.card:not(.back)').length);
    expect(counts()).toEqual([17, 17, 0]);
    fireEvent.click(screen.getByRole('button', { name: '出牌记录' }));
    fireEvent.click(screen.getByRole('button', { name: '第 0 步 · 初始发牌' }));
    expect(counts()).toEqual([17, 17, 0]);
    fireEvent.click(screen.getByRole('button', { name: '返回实时' }));
    expect(counts()).toEqual([17, 17, 0]);
    expect(game.calls()).toBe(1);
  });

  it('resets revealed hands for a random new game and for a different room', async () => {
    const game = setup();
    const view = render(<App route={{ kind: 'room', id: game.room.id }} />);
    await screen.findByRole('main', { name: '三人斗地主牌桌' });
    fireEvent.click(screen.getByRole('button', { name: '盖住鲸鱼娘的手牌' }));
    fireEvent.click(screen.getByRole('button', { name: '随机新局' }));
    await waitFor(() => expect(game.replay().generation).toBe(2));
    await screen.findByRole('button', { name: '盖住鲸鱼娘的手牌' });
    expect(document.querySelectorAll('.hand-area .card.back')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '盖住鲸鱼娘的手牌' }));
    const second = game.manager.create({ players: [0, 1, 2].map((seat) => ({ name: 'Other ' + seat, kind: 'random', seat })) });
    view.rerender(<App route={{ kind: 'room', id: second.id }} />);
    await waitFor(() => expect(screen.getByRole('main', { name: '三人斗地主牌桌' }).getAttribute('data-room-id')).toBe(second.id));
    expect(screen.getByRole('button', { name: '盖住鲸鱼娘的手牌' }).getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelectorAll('.seat-2 .hand-area .card:not(.back)')).toHaveLength(17);
  });

  it('keeps hand choices independent for two spectators of the same room', async () => {
    const game = setup();
    const first = render(<App route={{ kind: 'room', id: game.room.id }} />);
    await within(first.container).findByRole('main', { name: '三人斗地主牌桌' });
    const second = render(<App route={{ kind: 'room', id: game.room.id }} />);
    await within(second.container).findByRole('main', { name: '三人斗地主牌桌' });
    fireEvent.click(within(first.container).getByRole('button', { name: '盖住鲸鱼娘的手牌' }));
    expect(first.container.querySelectorAll('.seat-2 .hand-area .card.back')).toHaveLength(17);
    expect(second.container.querySelectorAll('.seat-2 .hand-area .card:not(.back)')).toHaveLength(17);
    expect(game.calls()).toBe(0);
    expect(game.requests.some((request) => request.path.endsWith('/control'))).toBe(false);
  });

  it('never includes spectator reveals in any of the three model players requests', async () => {
    const game = setup({ model: true });
    await mount(game);
    fireEvent.click(screen.getByRole('button', { name: '盖住Claude大小姐的手牌' }));
    fireEvent.click(screen.getByRole('button', { name: '盖住鲸鱼娘的手牌' }));
    for (let step = 0; step < 3; step += 1) {
      const snapshot = game.replay().snapshots.at(-1)!;
      await act(async () => { await game.manager.control(game.room.id, 'step'); });
      const request = game.modelRequests.at(-1)!;
      const payload = JSON.parse(request.messages[1].content).game;
      expect(request.messages).toHaveLength(2);
      expect(payload.seat).toBe(snapshot.currentSeat);
      expect(payload.hand_cards).toEqual(snapshot.hands[snapshot.currentSeat].map((card) => card.id));
      expect(payload).not.toHaveProperty('hands');
      for (const [seat, hand] of snapshot.hands.entries()) if (seat !== snapshot.currentSeat) {
        for (const card of hand) expect(JSON.stringify(request.messages)).not.toContain(card.id);
      }
    }
    expect(game.modelRequests.map((request) => JSON.parse(request.messages[1].content).game.seat)).toEqual([0, 1, 2]);
    expect(game.requests.some((request) => request.path.endsWith('/control'))).toBe(false);
  });
});
