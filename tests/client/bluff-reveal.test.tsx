import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BluffReveal } from '../../client/components/BluffReveal.js';
import { useBluffPresentation } from '../../client/hooks/useBluffPresentation.js';
import { createBluffGame, observeBluff, applyBluffAction } from '../../server/bluff/game.js';
import { cardsFromRanks } from '../../server/game/cards.js';
import type { BluffReveal as Result, BluffRoomView } from '../../shared/bluff.js';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const result: Result = { challenger: 0, claimant: 1, rank: 'A', cards: cardsFromRanks(['A', 'A', '7']), lied: true, loser: 1, collected: 12 };

it('keeps identities and verdict hidden during suspense, reveals sequentially, then permits continuation', async () => {
  vi.useFakeTimers();
  const complete = vi.fn();
  render(<BluffReveal result={result} complete={complete} />);
  const dialog = screen.getByRole('dialog', { name: '质疑揭晓' });
  expect(within(dialog).getAllByRole('img').map((image) => image.getAttribute('aria-label'))).toEqual(['第 1 张盖牌', '第 2 张盖牌', '第 3 张盖牌']);
  expect(within(dialog).queryByText('抓到吹牛了！')).toBeNull();
  act(() => vi.advanceTimersByTime(1200));
  expect(within(dialog).getByRole('img', { name: result.cards[0].display })).toBeTruthy();
  expect(within(dialog).getByRole('img', { name: '第 3 张盖牌' })).toBeTruthy();
  expect(within(dialog).queryByRole('button', { name: /收牌/ })).toBeNull();
  act(() => vi.advanceTimersByTime(1800));
  expect(within(dialog).getByText('抓到吹牛了！')).toBeTruthy();
  expect(within(dialog).getByText('你质疑成功')).toBeTruthy();
  expect(within(dialog).getByText('质疑结算后，由你出下一手。')).toBeTruthy();
  expect(dialog.getAttribute('data-outcome')).toBe('win');
  expect(dialog.querySelectorAll('.is-lie')).toHaveLength(1);
  expect(within(dialog).getAllByRole('img').map((image) => image.getAttribute('aria-label'))).toEqual(result.cards.map((card) => card.display));
  const next = within(dialog).getByRole('button', { name: /继续对局/ });
  expect(document.activeElement).toBe(next);
  fireEvent.click(next);
  expect(complete).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(700));
  expect(complete).toHaveBeenCalledOnce();
});

it('shows the correct loser for a truthful claim and allows skipping without changing the outcome', async () => {
  vi.useFakeTimers();
  const complete = vi.fn();
  render(<BluffReveal result={{ ...result, cards: cardsFromRanks(['A', 'A']), lied: false, loser: 0, nextSeat: 1 }} complete={complete} />);
  fireEvent.click(screen.getByRole('button', { name: /直接看结果/ }));
  expect(screen.getByText('竟然全是真的。')).toBeTruthy();
  expect(screen.getByText('你质疑失败')).toBeTruthy();
  expect(screen.getByText('质疑结算后，由鲸鱼娘出下一手。')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('你收走桌面全部 12 张牌');
  expect(complete).not.toHaveBeenCalled();
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
  await act(async () => vi.advanceTimersByTimeAsync(700));
  expect(complete).toHaveBeenCalledOnce();
});

it('respects reduced motion and restores body scroll on unmount', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const view = render(<BluffReveal result={result} complete={() => {}} />);
  expect(screen.getByText('抓到吹牛了！')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /直接看结果/ })).toBeNull();
  expect(document.body.style.overflow).toBe('hidden');
  view.unmount();
  expect(document.body.style.overflow).toBe('');
});

it('buffers AI updates and final settlement, plays each new reveal once, and does not replay old history on load', () => {
  const state = createBluffGame(() => .999);
  const view = (): BluffRoomView => ({ ...observeBluff(state, 0), id: 'bluff_000000000001', generation: 1, thinking: false, error: null, model: 'test' });
  const { result: hook } = renderHook(useBluffPresentation);
  act(() => hook.current.update(view()));
  // A human final claim, challenged by the model. No win is shown before the reveal.
  const last = state.hands[0].find((card) => card.rank === 'A')!;
  state.hands[1].push(...state.hands[0].filter((card) => card.id !== last.id)); state.hands[0] = [last];
  applyBluffAction(state, 0, { type: 'play', cards: [last.id] });
  act(() => hook.current.update(view()));
  const covered = hook.current.room;
  applyBluffAction(state, 1, { type: 'challenge' });
  act(() => hook.current.update(view()));
  const animation = hook.current.reveal;
  expect(animation?.result.challenger).toBe(1);
  expect(animation?.endedGame).toBe(true);
  expect(hook.current.room).toBe(covered);
  expect(hook.current.room?.winner).toBeNull();
  act(() => hook.current.update({ ...view(), error: 'latest status' }));
  expect(hook.current.reveal).toBe(animation);
  act(() => hook.current.finishReveal());
  expect(hook.current.room).toMatchObject({ winner: 0, phase: 'finished', error: 'latest status' });
  act(() => hook.current.update(view()));
  expect(hook.current.reveal).toBeNull();
  act(() => hook.current.update(covered!));
  expect(hook.current.room?.phase).toBe('finished');
  const refreshed = renderHook(useBluffPresentation);
  act(() => refreshed.result.current.update(view()));
  expect(refreshed.result.current.reveal).toBeNull();
});

it('does not label a terminal challenge as another turn', () => {
  render(<BluffReveal result={{ ...result, lied: false, loser: 0 }} endedGame complete={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /直接看结果/ }));
  expect(screen.getByText('最后一手已通过验证，本局结束。')).toBeTruthy();
  expect(screen.queryByText(/出下一手/)).toBeNull();
  expect(screen.getByRole('button', { name: /查看本局结果/ })).toBeTruthy();
});

it('buffers an AI challenge and its next play, then resumes with human response controls', () => {
  const state = createBluffGame(() => .999);
  const view = (): BluffRoomView => ({ ...observeBluff(state, 0), id: 'bluff_000000000003', generation: 1, thinking: false, error: null, model: 'test' });
  const { result: hook } = renderHook(useBluffPresentation);
  act(() => hook.current.update(view()));
  applyBluffAction(state, 0, { type: 'play', cards: [state.hands[0].find((card) => card.rank !== 'A')!.id] });
  act(() => hook.current.update(view()));
  applyBluffAction(state, 1, { type: 'challenge' });
  applyBluffAction(state, 1, { type: 'play', cards: [state.hands[1][0].id] });
  act(() => hook.current.update(view()));
  expect(hook.current.reveal).toMatchObject({ result: { challenger: 1, lied: true, loser: 0 }, endedGame: false });
  expect(hook.current.room?.revision).toBe(1);
  act(() => hook.current.finishReveal());
  expect(hook.current.room).toMatchObject({ revision: 3, phase: 'respond', turn: 0, claim: { seat: 1 } });
});

it('cancels the previous reveal when the room generation changes', () => {
  const state = createBluffGame();
  const initial: BluffRoomView = { ...observeBluff(state, 0), id: 'bluff_000000000002', generation: 1, thinking: false, error: null, model: 'test' };
  const { result: hook } = renderHook(useBluffPresentation);
  act(() => hook.current.update(initial));
  act(() => hook.current.update({ ...initial, revision: 2, lastReveal: result, history: [{ sequence: 2, seat: 0, type: 'challenge', reveal: result }] }));
  expect(hook.current.reveal).toBeTruthy();
  act(() => hook.current.update({ ...initial, generation: 2 }));
  expect(hook.current.reveal).toBeNull();
  expect(hook.current.room?.generation).toBe(2);
});

it('keeps a failed reveal confirmation retryable without replaying cards', async () => {
  vi.useFakeTimers();
  const complete = vi.fn().mockRejectedValueOnce(new Error('网络暂不可用')).mockResolvedValue(undefined);
  render(<BluffReveal result={result} complete={complete} />);
  fireEvent.click(screen.getByRole('button', { name: /直接看结果/ }));
  fireEvent.click(screen.getByRole('button', { name: /继续对局/ }));
  await act(async () => vi.advanceTimersByTimeAsync(700));
  expect(screen.getByRole('alert').textContent).toBe('网络暂不可用');
  expect((screen.getByRole('button', { name: /继续对局/ }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: /继续对局/ }));
  await act(async () => vi.advanceTimersByTimeAsync(700));
  expect(complete).toHaveBeenCalledTimes(2);
});

it('does not restore a pending reveal from a stale poll after confirmation', () => {
  const state = createBluffGame(() => .999);
  const view = (): BluffRoomView => ({ ...observeBluff(state, 0), id: 'bluff_000000000004', generation: 1, thinking: false, error: null, model: 'test', revealPending: null });
  const { result: hook } = renderHook(useBluffPresentation);
  act(() => hook.current.update(view()));
  applyBluffAction(state, 0, { type: 'play', cards: [state.hands[0][0].id] });
  applyBluffAction(state, 1, { type: 'challenge' });
  const pending = { ...view(), revealPending: 2 };
  act(() => hook.current.update(pending));
  act(() => { hook.current.update(view()); hook.current.finishReveal(); });
  act(() => hook.current.update(pending));
  expect(hook.current.room?.revealPending).toBeNull();
  expect(hook.current.reveal).toBeNull();
});
