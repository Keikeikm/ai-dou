import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../client/App.js';
import { readHumanControl } from '../../client/domain/human-control.js';
import { fixture } from './fixture.js';

const games: ReturnType<typeof fixture>[] = [];
afterEach(() => { cleanup(); for (const game of games.splice(0)) game.dispose(); vi.unstubAllGlobals(); });
function setup(options: Parameters<typeof fixture>[0] = {}) {
  const game = fixture({ human: true, model: true, ...options });
  games.push(game);
  return game;
}
async function mount(game: ReturnType<typeof fixture>) {
  const view = render(<App route={{ kind: 'room', id: game.room.id }} />);
  await screen.findByRole('main', { name: '三人斗地主牌桌' });
  return view;
}
async function armHuman(game: ReturnType<typeof fixture>) {
  await act(async () => { await game.manager.control(game.room.id, 'step'); await game.manager.control(game.room.id, 'step'); });
  await waitFor(() => expect((screen.getByRole('button', { name: '叫 3 分' }) as HTMLButtonElement).disabled).toBe(false));
}
async function armPlaying(game: ReturnType<typeof fixture>) {
  await armHuman(game);
  fireEvent.click(screen.getByRole('button', { name: '叫 3 分' }));
  await waitFor(() => expect(game.replay().snapshots.at(-1)!.phase).toBe('playing'));
  await act(async () => { await game.manager.control(game.room.id, 'step'); });
  await waitFor(() => expect((document.querySelector('.selectable-row button') as HTMLButtonElement).disabled).toBe(false));
}

describe('human versus AI interface', () => {
  it('creates one human and two AI without starting decisions', async () => {
    const game = setup();
    const navigate = vi.fn();
    render(<App route={{ kind: 'home' }} navigate={navigate} />);
    await waitFor(() => expect((screen.getByRole('button', { name: '人类 VS AI' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '人类 VS AI' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    const created = game.requests.find((request) => request.path === '/api/rooms')!;
    expect((created.body.players as { kind: string }[]).map((player) => player.kind)).toEqual(['deepseek', 'human', 'deepseek']);
    const id = navigate.mock.calls[0][0].split('/').at(-1);
    expect(readHumanControl(id)).toMatchObject({ seat: 1 });
    expect(game.calls()).toBe(0);
  });

  it('always shows only the human hand during play, persists ownership across refresh and displays human controls', async () => {
    const game = setup();
    const view = await mount(game);
    const count = () => [...document.querySelectorAll('.hand-area')].map((hand) => hand.querySelectorAll('.card:not(.back)').length);
    expect(count()).toEqual([0, 17, 0]);
    expect(screen.getByRole('region', { name: '真人操作' })).toBeTruthy();
    expect(document.body.textContent).not.toContain(game.room.humanControl!.token);
    await armHuman(game);
    expect(count()).toEqual([0, 17, 0]);
    view.unmount();
    await mount(game);
    expect(screen.getByRole('region', { name: '真人操作' })).toBeTruthy();
    expect(count()).toEqual([0, 17, 0]);
    expect(game.calls()).toBe(1);
  });

  it('supports bidding, stable multi-card selection and one submission even after repeated clicks', async () => {
    const game = setup();
    await mount(game);
    await armPlaying(game);
    const hand = game.replay().snapshots.at(-1)!.hands[1];
    const duplicate = hand.find((card) => hand.filter((other) => other.rank === card.rank).length >= 2)!;
    const pair = hand.filter((card) => card.rank === duplicate.rank).slice(0, 2);
    const own = screen.getByLabelText('你的手牌');
    const buttons = pair.map((card) => within(own).getByRole('button', { name: card.display }));
    for (const button of buttons) fireEvent.click(button);
    expect(buttons.every((button) => button.getAttribute('aria-pressed') === 'true')).toBe(true);
    act(() => game.sources.at(-1)!.emit({ ...game.replay(), revision: game.replay().revision + 1 }));
    expect(within(own).getByRole('button', { name: pair[0].display })).toBe(buttons[0]);
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
    const before = game.requests.filter((request) => request.path.endsWith('/human-action')).length;
    fireEvent.click(screen.getByRole('button', { name: '出牌', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: '出牌', exact: true }));
    await waitFor(() => expect(game.manager.getJournal(game.room.id).turns).toHaveLength(3));
    expect(game.requests.filter((request) => request.path.endsWith('/human-action'))).toHaveLength(before + 1);
    expect(game.manager.getJournal(game.room.id).turns[2]).toMatchObject({ source: 'human', action: { type: 'play' } });
    expect(game.replay().snapshots.at(-1)!.hands[1]).toHaveLength(hand.length - 2);
    expect(game.calls()).toBe(1);
  });

  it('keeps illegal selections editable and does not advance or silently fall back', async () => {
    const game = setup();
    await mount(game);
    await armPlaying(game);
    const hand = game.replay().snapshots.at(-1)!.hands[1];
    const cards = [hand[0], hand.find((card) => card.rank !== hand[0].rank)!];
    for (const card of cards) fireEvent.click(within(screen.getByLabelText('你的手牌')).getByRole('button', { name: card.display }));
    fireEvent.click(screen.getByRole('button', { name: '出牌', exact: true }));
    await screen.findByText(/所选牌型不合法/);
    expect(game.manager.getJournal(game.room.id).turns).toHaveLength(2);
    expect(document.querySelectorAll('.selectable-row [aria-pressed="true"]')).toHaveLength(2);
    expect((screen.getByRole('button', { name: '不出', exact: true }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '取消选择' }));
    expect(document.querySelectorAll('.selectable-row [aria-pressed="true"]')).toHaveLength(0);
  });

  it('allows passing an AI play but not leading with a pass', async () => {
    const game = setup();
    await mount(game);
    await armHuman(game);
    fireEvent.click(screen.getByRole('button', { name: '不叫', exact: true }));
    await waitFor(() => expect(game.replay().turns).toHaveLength(2));
    await act(async () => {
      await game.manager.control(game.room.id, 'step');
      await game.manager.control(game.room.id, 'step');
      await game.manager.control(game.room.id, 'step');
    });
    await waitFor(() => expect((screen.getByRole('button', { name: '不出', exact: true }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '不出', exact: true }));
    await waitFor(() => expect(game.replay().turns).toHaveLength(5));
    expect(game.replay().turns.at(-1)).toMatchObject({ source: 'human', decisionKind: 'human', action: { type: 'pass' } });
    expect(game.calls()).toBe(3);
  });

  it('does not grant spectators human control or allow actions while reviewing history', async () => {
    const spectator = setup({ spectator: true });
    const view = await mount(spectator);
    expect(screen.queryByRole('region', { name: '真人操作' })).toBeNull();
    expect(screen.queryByLabelText('你的手牌')).toBeNull();
    view.unmount();
    const player = setup();
    await mount(player);
    await armPlaying(player);
    fireEvent.click(screen.getByRole('button', { name: '出牌记录' }));
    fireEvent.click(screen.getByRole('button', { name: /第 0 步/ }));
    expect((screen.getByRole('button', { name: '叫 3 分' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/历史回看中，返回实时后才能操作/)).toBeTruthy();
    expect(player.requests.filter((request) => request.path.endsWith('/human-action'))).toHaveLength(1);
  });

  it('does not start model calls when AI keys are missing', async () => {
    const game = setup({ noKey: true });
    await mount(game);
    expect((screen.getByRole('button', { name: '开始对局' }) as HTMLButtonElement).disabled).toBe(true);
    expect(game.calls()).toBe(0);
  });
});
