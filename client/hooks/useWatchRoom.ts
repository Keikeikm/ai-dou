import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { archiveReplay, configuration, roomControl, roomReplay } from '../api/client.js';
import type { Replay, Route } from '../domain/types.js';
import { initialWatchState, watchReducer } from '../state/watch-state.js';

export function useWatchRoom(route: Route) {
  const [state, dispatch] = useReducer(watchReducer, initialWatchState);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(route.kind !== 'home');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [speed, setSpeed] = useState(1);
  const pending = useRef(false);
  const latest = useRef(state);
  const controllers = useRef(new Set<AbortController>());
  latest.current = state;
  const routeKey = route.kind === 'home' ? 'home' : route.kind + ':' + route.id;
  const viewedRoute = useRef(routeKey);

  useEffect(() => {
    if (viewedRoute.current !== routeKey) { viewedRoute.current = routeKey; dispatch({ type: 'reset' }); }
    if (route.kind === 'home') return;
    const controller = new AbortController();
    let source: EventSource | undefined;
    let active = true;
    setLoading(true);
    setError('');
    async function load() {
      try {
        if (route.kind === 'archive') {
          const record = await archiveReplay(route.id, controller.signal);
          if (!active) return;
          const replay: Replay = {
            generation: record.generation, revision: 0, snapshots: record.snapshots, turns: [...record.journal.turns],
            room: { id: record.roomId, name: '历史对局', status: 'closed', generation: record.generation, baseScore: record.settlement.baseScore,
              spectators: 0, viewUrl: '/games/' + record.gameId, players: record.entries.map((entry) => ({ ...entry, score: entry.afterScore, kind: 'archived' })) },
            session: { status: 'finished', turnTimeoutMs: 0, stepIntervalMs: 950 },
            accounting: { status: 'recorded', gameId: record.gameId, entries: [...record.entries] },
          };
          dispatch({ type: 'update', update: replay });
          dispatch({ type: 'seek', index: 0 });
          return;
        }
        if (route.kind !== 'room') return;
        await configuration(controller.signal);
        const replay = await roomReplay(route.id, controller.signal);
        if (!active) return;
        dispatch({ type: 'update', update: replay });
        if (replay.room.status === 'closed') return;
        source = new EventSource('/api/rooms/' + route.id + '/events');
        source.onopen = () => { if (active) setConnected(true); };
        source.onerror = () => { if (active) setConnected(false); };
        source.onmessage = (event) => {
          if (!active) return;
          try {
            const update = JSON.parse(event.data);
            if (update.index > (latest.current.replay?.snapshots.length ?? 0) && update.generation === latest.current.replay?.generation) {
              void roomReplay(route.id, controller.signal).then((full) => { if (active) dispatch({ type: 'update', update: full }); }).catch(() => { if (active) setConnected(false); });
              return;
            }
            dispatch({ type: 'update', update });
            if (update.room?.status === 'closed') { source?.close(); setConnected(false); }
          } catch { setConnected(false); }
        };
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : '加载失败');
      } finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; controller.abort(); source?.close(); setConnected(false); };
  }, [routeKey, refresh]);

  useEffect(() => () => { for (const controller of controllers.current) controller.abort(); }, []);

  useEffect(() => {
    if (!state.playing) return;
    const timer = setTimeout(() => dispatch({ type: 'tick' }), 950 / speed);
    return () => clearTimeout(timer);
  }, [state.playing, state.index, speed]);

  const control = useCallback(async (action: string) => {
    if (route.kind !== 'room' || pending.current) return;
    const controller = new AbortController();
    controllers.current.add(controller);
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      if (action === 'new-game') await configuration(controller.signal);
      const replay = await roomControl(route.id, action, controller.signal);
      dispatch({ type: 'update', update: replay });
      if (action === 'new-game') dispatch({ type: 'live' });
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '操作失败'); }
    finally { pending.current = false; controllers.current.delete(controller); if (!controller.signal.aborted) setBusy(false); }
  }, [routeKey]);

  return { ...state, loading, connected, busy, error, speed, setSpeed, dispatch, control, reload: () => setRefresh((value) => value + 1) };
}
