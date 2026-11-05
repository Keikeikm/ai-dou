import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../client/App.js';
import { BluffRooms } from '../../server/bluff/rooms.js';
import type { BluffObservation } from '../../shared/bluff.js';

let manager: BluffRooms | undefined;
afterEach(() => { cleanup(); manager?.dispose(); sessionStorage.clear(); vi.unstubAllGlobals(); });
function setup() {
  const calls: { path: string; body: Record<string, any> }[] = [];
  manager = new BluffRooms({ apiKey: 'server-test-key', transport: async (_credentials, request) => {
    const view = JSON.parse(request.messages[1].content) as BluffObservation;
    const action = view.phase === 'respond' ? { type: 'accept' } : { type: 'play', cards: view.hand.filter((card) => card.rank !== view.rank).slice(0, 2).map((card) => card.id) };
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(action) } }] };
  } });
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body ?? '{}'));
    calls.push({ path, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    try {
      if (path === '/api/providers/deepseek') return json({ hasServerKey: true, model: 'deepseek-flash' });
      if (path === '/api/bluff/rooms') return json(manager!.create(body), 201);
      const id = path.split('/').at(-1)!;
      const token = (init.headers as Record<string, string>).Authorization?.replace('Bearer ', '');
      if (init.method === 'POST') return json(manager!.control(id, token, body));
      return json(manager!.get(id, token));
    } catch (error) { return json({ error: (error as Error).message }, 400); }
  }));
  return calls;
}

it('opens the bluff setup without creating a room and uses the existing server key', async () => {
  const calls = setup();
  const navigate = vi.fn();
  render(<App route={{ kind: 'bluff' }} navigate={navigate} />);
  expect(screen.getByRole('main', { name: '吹牛开局' })).toBeTruthy();
  expect(screen.getByText('一分钟学会吹牛')).toBeTruthy();
  await waitFor(() => expect((screen.getByRole('button', { name: /开始和鲸鱼娘吹牛/ }) as HTMLButtonElement).disabled).toBe(false));
  expect(calls.map((call) => call.path)).toEqual(['/api/providers/deepseek']);
  fireEvent.click(screen.getByRole('button', { name: /开始和鲸鱼娘吹牛/ }));
  await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
  expect(navigate.mock.calls[0][0]).toMatch(/^\/bluff\/bluff_/);
  expect(calls.find((call) => call.path === '/api/bluff/rooms')?.body).toEqual({ apiKey: '' });
  expect(sessionStorage.getItem('ai-dou:bluff:' + navigate.mock.calls[0][0].split('/').at(-1))).toHaveLength(64);
  expect(JSON.stringify(sessionStorage)).not.toContain('server-test-key');
});

it('supports bounded selection, a single submission, AI response, challenge reveal and reload recovery', async () => {
  const calls = setup();
  const grant = manager!.create({});
  sessionStorage.setItem('ai-dou:bluff:' + grant.room.id, grant.token);
  let view = render(<App route={{ kind: 'bluff', id: grant.room.id }} />);
  const hand = await screen.findByRole('region', { name: '我的手牌' });
  const cards = within(hand).getAllByRole('button', { pressed: false });
  expect(cards).toHaveLength(26);
  for (const card of cards.slice(0, 5)) fireEvent.click(card);
  expect(within(hand).getAllByRole('button', { pressed: true })).toHaveLength(4);
  const play = screen.getByRole('button', { name: '盖牌，声称 4 张 A' });
  fireEvent.click(play); fireEvent.click(play);
  await screen.findByRole('button', { name: '你吹牛！翻牌' }, { timeout: 3500 });
  expect(calls.filter((call) => call.body.action?.type === 'play')).toHaveLength(1);
  expect(within(screen.getByRole('region', { name: '我的手牌' })).getAllByRole('button', { pressed: false })).toHaveLength(22);
  fireEvent.click(screen.getByRole('button', { name: '你吹牛！翻牌' }));
  const reveal = await screen.findByRole('dialog', { name: '质疑揭晓' });
  expect(manager!.get(grant.room.id, grant.token).revealPending).not.toBeNull();
  expect(screen.queryByText(/最近一次翻牌/)).toBeNull();
  expect(within(screen.getByRole('region', { name: '我的手牌' })).getAllByRole('button', { pressed: false })).toHaveLength(22);
  fireEvent.click(within(reveal).getByRole('button', { name: /直接看结果/ }));
  fireEvent.click(within(reveal).getByRole('button', { name: /继续对局/ }));
  await screen.findByText(/最近一次翻牌/);
  expect(calls.filter((call) => call.body.type === 'ack-reveal')).toHaveLength(1);
  expect(manager!.get(grant.room.id, grant.token).revealPending).toBeNull();
  expect(screen.getByRole('button', { name: '选牌后盖下' })).toBeTruthy();
  const currentHandCount = manager!.get(grant.room.id, grant.token).hand.length;
  view.unmount();
  view = render(<App route={{ kind: 'bluff', id: grant.room.id }} />);
  const restored = await screen.findByRole('region', { name: '我的手牌' });
  expect(within(restored).getAllByRole('button', { pressed: false })).toHaveLength(currentHandCount);
  expect(screen.queryByRole('dialog', { name: '质疑揭晓' })).toBeNull();
  const actionsBeforeReplay = calls.filter((call) => call.body.action).length;
  fireEvent.click(screen.getByRole('button', { name: /重看翻牌/ }));
  expect(screen.getByRole('dialog', { name: '质疑揭晓' })).toBeTruthy();
  expect(calls.filter((call) => call.body.action)).toHaveLength(actionsBeforeReplay);
  expect(screen.queryByRole('button', { name: /盖住鲸鱼娘/ })).toBeNull();
});

it('shows a recoverable missing-seat error without exposing a game', async () => {
  const calls = setup();
  render(<App route={{ kind: 'bluff', id: 'bluff_000000000000' }} />);
  await screen.findByRole('alert');
  expect(screen.getByRole('link', { name: '重新开局' })).toBeTruthy();
  expect(screen.queryByRole('main', { name: '双人吹牛牌桌' })).toBeNull();
  expect(calls).toHaveLength(0);
});

it('can resume a reveal awaiting confirmation after refreshing the page', async () => {
  const calls = setup();
  const grant = manager!.create({});
  sessionStorage.setItem('ai-dou:bluff:' + grant.room.id, grant.token);
  manager!.control(grant.room.id, grant.token, { generation: 1, revision: 0, action: { type: 'play', cards: [grant.room.hand[0].id] } });
  await waitFor(() => expect(manager!.get(grant.room.id, grant.token).thinking).toBe(false));
  const before = manager!.get(grant.room.id, grant.token);
  manager!.control(before.id, grant.token, { generation: 1, revision: before.revision, action: { type: 'challenge' } });
  render(<App route={{ kind: 'bluff', id: grant.room.id }} />);
  const resume = await screen.findByRole('button', { name: '确认翻牌，继续对局' });
  expect((screen.getByRole('button', { name: '选牌后盖下' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(resume); fireEvent.click(resume);
  await waitFor(() => expect(manager!.get(before.id, grant.token).revealPending).toBeNull());
  expect(calls.filter((call) => call.body.type === 'ack-reveal')).toHaveLength(1);
  const hand = screen.getByRole('region', { name: '我的手牌' });
  expect((within(hand).getAllByRole('button', { pressed: false })[0] as HTMLButtonElement).disabled).toBe(false);
});
