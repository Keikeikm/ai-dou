import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../client/App.js';
import { CardRow } from '../../client/components/Cards.js';
import { DecisionClock } from '../../client/components/DecisionClock.js';
import { Table } from '../../client/components/Table.js';
import { cardsFromRanks } from '../../server/game/cards.js';
import type { GameSnapshot } from '../../client/domain/types.js';
import { fixture } from './fixture.js';

const games: ReturnType<typeof fixture>[] = [];
afterEach(() => { cleanup(); for (const game of games.splice(0)) game.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const setup = () => { const game = fixture({ model: true }); games.push(game); return game; };

describe('stable spectator rendering', () => {
  it('preserves all hand containers and cards when the acting seat changes', async () => {
    const game = setup();
    render(<App route={{ kind: 'room', id: game.room.id }} />);
    await screen.findByRole('main', { name: '三人斗地主牌桌' });
    const rows = [...document.querySelectorAll('.hand-area .card-row')];
    const cards = rows.map((row) => [...row.querySelectorAll('.card')]);
    await act(async () => { await game.manager.control(game.room.id, 'step'); });
    [...document.querySelectorAll('.hand-area .card-row')].forEach((row, seat) => expect(row).toBe(rows[seat]));
    rows.forEach((row, seat) => [...row.querySelectorAll('.card')].forEach((card, position) => expect(card).toBe(cards[seat][position])));
    expect(game.calls()).toBe(1);
  });

  it('preserves the same public play across a pass and status notifications', () => {
    const game = setup();
    const replay = game.replay();
    const pair = cardsFromRanks(['3', '3']);
    const snapshot: GameSnapshot = { ...replay.snapshots[0], phase: 'playing', landlord: 0, currentSeat: 1,
      lastPlay: { seat: 0, cards: pair, type: 'pair' }, logs: [{ seat: 0, action: 'play', cards: pair }] };
    const props = { replay, snapshot, index: 1, followLive: true, dealStage: '', connected: false, inspect: vi.fn(), settings: vi.fn() };
    const view = render(<Table {...props} />);
    expect(view.container.querySelectorAll('.portrait-turn')).toHaveLength(1);
    expect(view.container.querySelector('.seat-1 .portrait-turn')?.textContent).toBe('出牌中');
    const row = view.container.querySelector('.trick-area .card-row');
    const first = row?.firstElementChild;
    const afterPass: GameSnapshot = { ...snapshot, currentSeat: 2, logs: [...snapshot.logs, { seat: 1, action: 'pass', cards: [] }] };
    view.rerender(<Table {...props} snapshot={afterPass} index={2} />);
    expect(view.container.querySelector('.seat-1 .portrait-turn')).toBeNull();
    expect(view.container.querySelector('.seat-2 .portrait-turn')?.textContent).toBe('出牌中');
    expect(view.container.querySelector('.trick-area .card-row')).toBe(row);
    expect(row?.firstElementChild).toBe(first);
    view.rerender(<Table {...props} snapshot={{ ...afterPass, phase: 'finished' }} />);
    expect(view.container.querySelector('.portrait-turn')).toBeNull();
    view.rerender(<Table {...props} snapshot={afterPass} index={2} replay={{ ...replay, revision: replay.revision + 1 }} />);
    expect(row?.firstElementChild).toBe(first);
  });

  it('uses CSS layout without reading card geometry during React renders', () => {
    const game = setup();
    const geometry = vi.spyOn(Element.prototype, 'getBoundingClientRect');
    const cards = game.replay().snapshots[0].hands[0];
    const view = render(<CardRow cards={cards} hand />);
    view.rerender(<CardRow cards={cards.slice(1)} hand />);
    expect(geometry).not.toHaveBeenCalled();
  });

  it('animates only a new adjacent play, not mounting, duplicates, passes or history jumps', () => {
    const game = fixture({ reducedMotion: false });
    games.push(game);
    const original = Element.prototype.animate;
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }));
    Element.prototype.animate = animate as unknown as typeof original;
    try {
      const cards = cardsFromRanks(['4', '4']);
      const view = render(<CardRow cards={cards} step={0} animate />);
      expect(animate).not.toHaveBeenCalled();
      const row = view.container.firstElementChild;
      view.rerender(<CardRow cards={cards} step={1} animate />);
      expect(animate).toHaveBeenCalledTimes(1);
      view.rerender(<CardRow cards={cards.map((card) => ({ ...card }))} step={1} animate />);
      expect(animate).toHaveBeenCalledTimes(1);
      view.rerender(<CardRow cards={cards} step={2} animate={false} />);
      expect(cancel).toHaveBeenCalledTimes(1);
      view.rerender(<CardRow cards={cards} step={5} animate />);
      expect(animate).toHaveBeenCalledTimes(1);
      view.rerender(<CardRow cards={cards} step={6} animate />);
      expect(animate).toHaveBeenCalledTimes(2);
      view.rerender(<CardRow cards={cards} animate />);
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(view.container.firstElementChild).toBe(row);
    } finally { if (original) Element.prototype.animate = original; else Reflect.deleteProperty(Element.prototype, 'animate'); }
  });

  it('updates the countdown without rerendering its parent or starting additional decisions', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const session = { status: 'running', turnTimeoutMs: 4000, stepIntervalMs: 950, serverTime: 1000,
      decision: { sequence: 1, seat: 0, phase: 'calling' as const, startedAt: 1000, deadline: 5000 } };
    const Parent = vi.fn(() => <DecisionClock session={session} enabled model />);
    const view = render(<Parent />);
    expect(Parent).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('status').textContent).toContain('3.5s');
    expect(Parent).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
