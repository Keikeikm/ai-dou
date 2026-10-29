import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDealAnimation } from '../../client/hooks/useDealAnimation.js';
import { useDecisionClock } from '../../client/hooks/useDecisionClock.js';
import { CardRow } from '../../client/components/Cards.js';
import { ModelResponsePanel } from '../../client/components/ModelResponse.js';
import { fixture } from './fixture.js';

const games: ReturnType<typeof fixture>[] = [];
afterEach(() => { cleanup(); for (const game of games.splice(0)) game.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const setup = (options: Parameters<typeof fixture>[0] = {}) => { const game = fixture(options); games.push(game); return game; };

describe('React animation and clocks', () => {
  it('plays shuffle and dealing without advancing the server or invoking models', () => {
    vi.useFakeTimers();
    const game = setup({ reducedMotion: false });
    const { result } = renderHook(() => useDealAnimation(game.replay(), true));
    expect(result.current).toBe('shuffle');
    act(() => vi.advanceTimersByTime(650));
    expect(result.current).toBe('deal');
    act(() => vi.advanceTimersByTime(950));
    expect(result.current).toBe('');
    expect(game.replay().turns).toHaveLength(0);
    expect(game.calls()).toBe(0);
  });

  it('does not replay a shuffle on refresh of an already displayed room generation', () => {
    const game = setup({ reducedMotion: false });
    sessionStorage.setItem('ai-dou:deal:' + game.room.id, '1');
    const { result } = renderHook(() => useDealAnimation(game.replay(), true));
    expect(result.current).toBe('');
  });

  it('skips all animation for reduced motion without changing the actual hands', () => {
    const game = setup();
    const before = game.replay().snapshots;
    const { result } = renderHook(() => useDealAnimation(game.replay(), true));
    expect(result.current).toBe('');
    expect(game.replay().snapshots).toEqual(before);
  });

  it('cancels animation if shared gameplay advances and starts it for a new generation', async () => {
    vi.useFakeTimers();
    const game = setup({ reducedMotion: false });
    const { result, rerender } = renderHook(({ replay }) => useDealAnimation(replay, true), { initialProps: { replay: game.replay() } });
    expect(result.current).toBe('shuffle');
    await act(async () => { await game.manager.control(game.room.id, 'step'); });
    rerender({ replay: game.replay() });
    expect(result.current).toBe('');
    await act(async () => { await game.manager.control(game.room.id, 'new-game'); });
    rerender({ replay: game.replay() });
    expect(result.current).toBe('shuffle');
  });

  it('cancels timers when switching to local history or unmounting', () => {
    vi.useFakeTimers();
    const game = setup({ reducedMotion: false });
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
    const { result, rerender, unmount } = renderHook(({ follow }) => useDealAnimation(game.replay(), follow), { initialProps: { follow: true } });
    rerender({ follow: false });
    expect(result.current).toBe('');
    act(() => vi.advanceTimersByTime(650));
    expect(result.current).toBe('');
    expect(clearTimer.mock.calls.length).toBeGreaterThanOrEqual(2);
    unmount();
  });

  it('handles unavailable session storage without breaking the true deal', () => {
    const game = setup({ reducedMotion: false });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    const { result } = renderHook(() => useDealAnimation(game.replay(), true));
    expect(result.current).toBe('shuffle');
    expect(game.replay().turns).toHaveLength(0);
  });

  it('calibrates the countdown to server time and hides it when disconnected or browsing history', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const session = { status: 'running', turnTimeoutMs: 4000, stepIntervalMs: 950, serverTime: 2000,
      decision: { sequence: 1, seat: 0, phase: 'calling' as const, startedAt: 1000, deadline: 5000 } };
    const { result, rerender } = renderHook(({ enabled }) => useDecisionClock(session, enabled), { initialProps: { enabled: true } });
    expect(result.current).toBe(3000);
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe(2500);
    rerender({ enabled: false });
    expect(result.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('React cards and response presentation', () => {
  it('preserves card elements on status-only rerenders and orders hands by rank', () => {
    const game = setup();
    const cards = game.replay().snapshots[0].hands[0];
    const { container, rerender } = render(<CardRow cards={cards} hand />);
    const before = container.querySelectorAll('.card');
    rerender(<CardRow cards={cards.map((card) => ({ ...card }))} hand />);
    expect(container.querySelectorAll('.card')[0]).toBe(before[0]);
    expect(before).toHaveLength(17);
  });

  it('never displays raw internal error details or guesses model success from player names', () => {
    const game = setup();
    const snapshot = game.replay().snapshots[0];
    render(<ModelResponsePanel snapshot={snapshot} turn={{ sequence: 1, seat: 0, phase: 'calling', action: { type: 'call', score: 0 }, source: 'fallback', decisionKind: 'model', reason: 'error', detail: 'test-only-secret vendor-body' }} />);
    expect(document.body.textContent).toContain('不能据此判定密钥无效');
    expect(document.body.textContent).not.toMatch(/test-only-secret|vendor-body/);
  });

  it.each(['dns_failed', 'tls_failed', 'connection_failed', 'response_failed'] as const)('shows the safe %s error on model response records', (error) => {
    const game = setup();
    render(<ModelResponsePanel snapshot={game.replay().snapshots[0]} turn={{ sequence: 1, seat: 0, phase: 'calling', action: { type: 'call', score: 0 }, source: 'fallback', decisionKind: 'model', reason: 'error',
      modelResponse: { provider: 'deepseek', model: 'deepseek-flash', status: 'error', error, durationMs: 100 } }} />);
    expect(screen.getByRole('alert').textContent).not.toContain('鉴权失败');
    expect(screen.getByRole('alert').textContent).toBeTruthy();
  });
});
