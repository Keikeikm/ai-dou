import { describe, expect, it } from 'vitest';
import { initialWatchState, watchReducer } from '../../client/state/watch-state.js';
import { fixture } from './fixture.js';

describe('React spectator state', () => {
  it('applies genuinely changed snapshot data without mutating the previously cached hand', () => {
    const game = fixture();
    try {
      const replay = game.replay();
      const state = watchReducer(initialWatchState, { type: 'update', update: replay });
      const original = replay.snapshots[0].hands[0][0].display;
      const corrected = { ...replay, revision: replay.revision + 1, snapshots: replay.snapshots.map((snapshot) => ({ ...snapshot,
        hands: snapshot.hands.map((hand, seat) => seat === 0 ? hand.map((card, position) => position === 0 ? { ...card, display: '修正显示' } : card) : hand) })) };
      const after = watchReducer(state, { type: 'update', update: corrected });
      expect(after.replay?.snapshots[0].hands[0][0].display).toBe('修正显示');
      expect(state.replay?.snapshots[0].hands[0][0].display).toBe(original);
      expect(after.replay?.snapshots[0].hands[1]).toBe(state.replay?.snapshots[0].hands[1]);
    } finally { game.dispose(); }
  });
  it('shares unchanged snapshots, hands and turns across metadata-only SSE updates', async () => {
    const game = fixture();
    try {
      await game.manager.control(game.room.id, 'step');
      const replay = game.replay();
      const before = watchReducer(initialWatchState, { type: 'update', update: replay });
      const update = structuredClone({ ...replay, snapshots: undefined, turns: undefined, index: 1, snapshot: replay.snapshots[1], turn: replay.turns[0],
        revision: replay.revision + 1, room: { ...replay.room, spectators: replay.room.spectators + 1 } });
      const after = watchReducer(before, { type: 'update', update });
      expect(after.replay?.snapshots).toBe(before.replay?.snapshots);
      expect(after.replay?.snapshots[1].hands).toBe(before.replay?.snapshots[1].hands);
      expect(after.replay?.turns).toBe(before.replay?.turns);
      expect(after.replay?.room.players).toBe(before.replay?.room.players);
      expect(watchReducer(after, { type: 'update', update })).toBe(after);
    } finally { game.dispose(); }
  });
  it('ignores stale revisions, prior generations and updates from unrelated rooms', () => {
    const game = fixture();
    try {
      const replay = game.replay();
      const state = watchReducer(initialWatchState, { type: 'update', update: replay });
      for (const update of [{ ...replay, revision: -1 }, { ...replay, generation: 0 }, { ...replay, room: { ...replay.room, id: 'room_000000000000' } }]) {
        expect(watchReducer(state, { type: 'update', update })).toBe(state);
      }
    } finally { game.dispose(); }
  });

  it('keeps history positions while the server advances and returns to the live edge explicitly', async () => {
    const game = fixture();
    try {
      await game.manager.control(game.room.id, 'step');
      let state = watchReducer(initialWatchState, { type: 'update', update: game.replay() });
      state = watchReducer(state, { type: 'seek', index: 0 });
      await game.manager.control(game.room.id, 'step');
      state = watchReducer(state, { type: 'update', update: game.replay() });
      expect(state.index).toBe(0);
      expect(state.followLive).toBe(false);
      expect(watchReducer(state, { type: 'live' }).index).toBe(2);
    } finally { game.dispose(); }
  });

  it('merges duplicate incremental turns without duplicating history and rejects gaps', async () => {
    const game = fixture();
    try {
      let state = watchReducer(initialWatchState, { type: 'update', update: game.replay() });
      await game.manager.control(game.room.id, 'step');
      const replay = game.replay();
      const update = { ...replay, snapshots: undefined, turns: undefined, index: 1, snapshot: replay.snapshots[1], turn: replay.turns[0] };
      state = watchReducer(state, { type: 'update', update });
      state = watchReducer(state, { type: 'update', update });
      expect(state.replay?.turns).toHaveLength(1);
      expect(watchReducer(state, { type: 'update', update: { ...update, index: 7 } })).toBe(state);
    } finally { game.dispose(); }
  });

  it('resets local playback and cache for a new randomly dealt generation', async () => {
    const game = fixture();
    try {
      await game.manager.control(game.room.id, 'step');
      let state = watchReducer(initialWatchState, { type: 'update', update: game.replay() });
      state = watchReducer(state, { type: 'play', fromStart: true });
      await game.manager.control(game.room.id, 'new-game');
      state = watchReducer(state, { type: 'update', update: game.replay() });
      expect(state.index).toBe(0);
      expect(state.playing).toBe(false);
      expect(state.followLive).toBe(true);
      expect(state.replay?.turns).toHaveLength(0);
    } finally { game.dispose(); }
  });

  it('bounds seeking and stops playback at the cached end without switching to live', async () => {
    const game = fixture();
    try {
      await game.manager.control(game.room.id, 'step');
      const state = watchReducer(initialWatchState, { type: 'update', update: game.replay() });
      expect(watchReducer(state, { type: 'seek', index: -10 }).index).toBe(0);
      expect(watchReducer(state, { type: 'seek', index: 999 }).index).toBe(1);
      const playback = watchReducer(watchReducer(state, { type: 'play' }), { type: 'tick' });
      expect(playback).toMatchObject({ index: 1, playing: false, followLive: false });
    } finally { game.dispose(); }
  });
});
