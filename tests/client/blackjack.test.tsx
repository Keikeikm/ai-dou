import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BlackjackGame } from '../../client/components/BlackjackGame.js';
import { BLACKJACK_RULES_VERSION, type BlackjackRoomView } from '../../shared/blackjack.js';
import { createDeck } from '../../server/game/cards.js';

afterEach(() => { cleanup(); sessionStorage.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const card = (display: string) => createDeck().find((item) => item.display === display)!;
function active(): BlackjackRoomView {
  return { id: 'blackjack_000000000001', generation: 1, rulesVersion: BLACKJACK_RULES_VERSION, seat: 0,
    hand: [card('♠10'), card('♥6')], opponent: [card('♣9'), null],
    handValue: { total: 16, soft: false, blackjack: false, bust: false }, opponentValue: null,
    phase: 'play', turn: 0, stood: [false, false], result: null, winner: null, reason: null, revision: 0, history: [], thinking: false, error: null, model: 'deepseek-flash' };
}
function settled(): BlackjackRoomView {
  return { ...active(), opponent: [card('♣9'), card('♦6')], opponentValue: { total: 15, soft: false, blackjack: false, bust: false },
    phase: 'finished', stood: [true, true], result: 'win', winner: 0, reason: 'higher-total', revision: 2,
    history: [{ sequence: 1, seat: 0, type: 'stand' }, { sequence: 2, seat: 1, type: 'stand' }] };
}
function setup(initial = active()) {
  let room = initial;
  const calls: { path: string; method?: string; body: Record<string, any> }[] = [];
  sessionStorage.setItem('ai-dou:blackjack:' + room.id, 'test-seat-token');
  const fetcher = vi.fn(async (path: string, options: RequestInit = {}) => {
    const body = JSON.parse(String(options.body ?? '{}'));
    calls.push({ path, method: options.method, body });
    if (path === '/api/providers/deepseek') return new Response(JSON.stringify({ hasServerKey: true }));
    if (path === '/api/blackjack/rooms') return new Response(JSON.stringify({ room, token: 'new-seat-token' }));
    if (options.method === 'DELETE') return new Response(JSON.stringify({ closed: true }));
    if (options.method === 'POST') room = body.type === 'restart' ? { ...active(), generation: room.generation + 1 } : settled();
    return new Response(JSON.stringify(room));
  });
  vi.stubGlobal('fetch', fetcher);
  return { calls, fetcher, setRoom: (value: BlackjackRoomView) => { room = value; } };
}

it('starts a DeepSeek duel only after confirmation and preserves the seat token', async () => {
  const { calls } = setup(); const navigate = vi.fn();
  render(<BlackjackGame navigate={navigate} />);
  expect(screen.getByRole('main', { name: '21点开局' })).toBeTruthy();
  expect(screen.getByText('一分钟学会 21 点')).toBeTruthy();
  const start = screen.getByRole('button', { name: /和鲸鱼娘玩 21 点/ });
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  fireEvent.click(start); fireEvent.click(start);
  await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
  expect(navigate).toHaveBeenCalledWith('/blackjack/blackjack_000000000001');
  expect(calls.filter((call) => call.path === '/api/blackjack/rooms')).toHaveLength(1);
  expect(calls.find((call) => call.path === '/api/blackjack/rooms')?.body.apiKey).toBe('');
  expect(sessionStorage.getItem('ai-dou:blackjack:blackjack_000000000001')).toBe('new-seat-token');
});

it('hides hole cards and result until revealed, prevents duplicate actions, and restores a finished game without replaying', async () => {
  const { calls } = setup();
  const rendered = render(<BlackjackGame id={active().id} navigate={vi.fn()} />);
  await screen.findByRole('main', { name: '21点牌桌' });
  expect(screen.queryByRole('img', { name: '♦6' })).toBeNull();
  expect(screen.getByRole('img', { name: '鲸鱼娘第 2 张暗牌' })).toBeTruthy();
  const stand = screen.getByRole('button', { name: /停牌 就到这里/ });
  fireEvent.click(stand); fireEvent.click(stand);
  await screen.findByRole('button', { name: /直接看结果/ });
  expect(screen.queryByRole('img', { name: '♦6' })).toBeNull();
  expect(screen.queryByRole('heading', { name: '这局，是你赢了！' })).toBeNull();
  expect(within(screen.getByRole('complementary', { name: '公开牌局记录' })).queryByText('鲸鱼娘选择停牌')).toBeNull();
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  expect(calls.find((call) => call.method === 'POST')?.body).toEqual({ action: { type: 'stand' }, revision: 0, generation: 1 });
  fireEvent.click(screen.getByRole('button', { name: /直接看结果/ }));
  expect(screen.getByRole('img', { name: '♦6' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: '这局，是你赢了！' })).toBeTruthy();
  rendered.unmount();
  render(<BlackjackGame id={active().id} navigate={vi.fn()} />);
  await screen.findByRole('heading', { name: '这局，是你赢了！' });
  expect(screen.queryByRole('button', { name: /直接看结果/ })).toBeNull();
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: /再来一局/ }));
  await screen.findByText('第 2 局');
  expect(screen.getByRole('img', { name: '鲸鱼娘第 2 张暗牌' })).toBeTruthy();
});

it('does not replace a finished result with an old in-flight poll', async () => {
  vi.useFakeTimers();
  const { fetcher } = setup();
  render(<BlackjackGame id={active().id} navigate={vi.fn()} />);
  await act(async () => {});
  let release!: (response: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /停牌 就到这里/ })); });
  await act(async () => { release(new Response(JSON.stringify(active()))); });
  expect(screen.getByRole('button', { name: /直接看结果/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /要牌 再拿一张/ })).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });
  expect(screen.getByRole('img', { name: '♦6' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: '这局，是你赢了！' })).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  expect(screen.getByRole('heading', { name: '这局，是你赢了！' })).toBeTruthy();
});

it('disables decisions while the model acts and supports retrying an error without losing the hand', async () => {
  const room = { ...active(), turn: 1 as const, thinking: false, error: '鲸鱼娘思考超时，请重试这一动作。' };
  const { calls } = setup(room);
  render(<BlackjackGame id={room.id} navigate={vi.fn()} />);
  await screen.findByRole('alert');
  expect((screen.getByRole('button', { name: /要牌 再拿一张/ }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: /停牌 就到这里/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(screen.getByRole('region', { name: '我的手牌' })).getAllByRole('img')).toHaveLength(2);
  fireEvent.change(screen.getByLabelText('更换密钥（可选）'), { target: { value: 'replacement-key' } });
  fireEvent.click(screen.getByRole('button', { name: '重试鲸鱼娘的动作' }));
  await screen.findByRole('button', { name: /直接看结果/ });
  expect(calls.find((call) => call.method === 'POST')?.body).toMatchObject({ type: 'retry', apiKey: 'replacement-key' });
  expect(JSON.stringify(sessionStorage)).not.toContain('replacement-key');
});

it('respects reduced motion and closes the room before returning to the lobby', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const { calls } = setup(); const navigate = vi.fn();
  render(<BlackjackGame id={active().id} navigate={navigate} />);
  await screen.findByRole('main', { name: '21点牌桌' });
  fireEvent.click(screen.getByRole('button', { name: /停牌 就到这里/ }));
  await screen.findByRole('heading', { name: '这局，是你赢了！' });
  expect(screen.queryByRole('button', { name: /直接看结果/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /返回大厅/ }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
  expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  expect(sessionStorage.getItem('ai-dou:blackjack:' + active().id)).toBeNull();
});

it('shows a missing-seat recovery without requesting private game data', async () => {
  const { calls } = setup(); sessionStorage.clear();
  render(<BlackjackGame id={active().id} navigate={vi.fn()} />);
  await screen.findByRole('alert');
  expect(screen.getByRole('link', { name: '重新开局' })).toBeTruthy();
  expect(calls).toHaveLength(0);
});

it('reveals a newly created natural once, and does not replay it after refreshing', async () => {
  const natural: BlackjackRoomView = { ...settled(), hand: [card('♠A'), card('♥K')], handValue: { total: 21, soft: true, blackjack: true, bust: false }, reason: 'player-blackjack', revision: 0, history: [] };
  setup(natural); const navigate = vi.fn();
  let rendered = render(<BlackjackGame navigate={navigate} />);
  const start = screen.getByRole('button', { name: /和鲸鱼娘玩 21 点/ });
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(start);
  await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
  rendered.unmount();
  rendered = render(<BlackjackGame id={natural.id} navigate={navigate} />);
  await screen.findByRole('button', { name: /直接看结果/ });
  expect(screen.queryByRole('img', { name: '♦6' })).toBeNull();
  expect(screen.queryByRole('heading', { name: '这局，是你赢了！' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /直接看结果/ }));
  expect(screen.getByText('你起手就是 A 加一张 10 点牌，天生 21 点！')).toBeTruthy();
  rendered.unmount();
  render(<BlackjackGame id={natural.id} navigate={navigate} />);
  await screen.findByRole('heading', { name: '这局，是你赢了！' });
  expect(screen.queryByRole('button', { name: /直接看结果/ })).toBeNull();
});
