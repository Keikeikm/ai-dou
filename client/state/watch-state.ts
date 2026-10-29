import type { LiveUpdate, Replay } from '../domain/types.js';

export interface WatchState {
  replay: Replay | null;
  index: number;
  followLive: boolean;
  playing: boolean;
}

export const initialWatchState: WatchState = { replay: null, index: 0, followLive: true, playing: false };
export type WatchAction = { type: 'update'; update: LiveUpdate } | { type: 'seek'; index: number } | { type: 'live' } | { type: 'play'; fromStart?: boolean } | { type: 'pause' } | { type: 'tick' } | { type: 'reset' };

function reuseUnchanged<Value>(previous: Value | undefined, incoming: Value): Value {
  if (previous === incoming) return incoming;
  if (Array.isArray(previous) && Array.isArray(incoming)) {
    const values = incoming.map((value, index) => reuseUnchanged(previous[index], value));
    return (previous.length === values.length && values.every((value, index) => value === previous[index]) ? previous : values) as Value;
  }
  if (previous && incoming && typeof previous === 'object' && typeof incoming === 'object' && !Array.isArray(previous) && !Array.isArray(incoming)) {
    const before = previous as Record<string, unknown>;
    const after = incoming as Record<string, unknown>;
    const keys = Object.keys(after);
    const values = Object.fromEntries(keys.map((key) => [key, reuseUnchanged(before[key], after[key])]));
    return (Object.keys(before).length === keys.length && keys.every((key) => Object.hasOwn(before, key) && before[key] === values[key]) ? previous : values) as Value;
  }
  return incoming;
}

export function watchReducer(state: WatchState, action: WatchAction): WatchState {
  if (action.type === 'reset') return initialWatchState;
  const lastIndex = Math.max(0, (state.replay?.snapshots.length ?? 1) - 1);
  if (action.type === 'seek') return { ...state, index: Math.max(0, Math.min(lastIndex, action.index)), followLive: false, playing: false };
  if (action.type === 'live') return { ...state, index: lastIndex, followLive: true, playing: false };
  if (action.type === 'pause') return { ...state, playing: false };
  if (action.type === 'play') return { ...state, index: action.fromStart || state.index === lastIndex ? 0 : state.index, followLive: false, playing: lastIndex > 0 };
  if (action.type === 'tick') return { ...state, index: Math.min(lastIndex, state.index + 1), playing: state.index + 1 < lastIndex };
  const update = action.update;
  const old = state.replay;
  if (old && (update.room.id !== old.room.id || update.generation < old.generation || (update.generation === old.generation && update.revision < old.revision))) return state;
  const changed = !old || update.generation !== old.generation;
  const snapshots = update.snapshots ? [...update.snapshots] : changed ? [] : [...old!.snapshots];
  const turns = update.turns ? [...update.turns] : changed ? [] : [...old!.turns];
  if (!update.snapshots && update.snapshot && update.index !== undefined) {
    if (update.index > snapshots.length) return state;
    snapshots[update.index] = update.snapshot;
    if (update.turn && update.index > 0) turns[update.index - 1] = update.turn;
  } else if (update.room.status === 'waiting') {
    snapshots.length = 0;
    turns.length = 0;
  }
  const followLive = changed || state.followLive;
  const latest = Math.max(0, snapshots.length - 1);
  const replay = reuseUnchanged(changed ? undefined : old ?? undefined, {
    room: update.room, generation: update.generation, revision: update.revision, session: update.session, accounting: update.accounting, snapshots, turns,
  });
  const index = followLive ? latest : Math.min(state.index, latest);
  const playing = changed ? false : state.playing;
  return replay === old && index === state.index && followLive === state.followLive && playing === state.playing ? state : { replay, index, followLive, playing };
}
