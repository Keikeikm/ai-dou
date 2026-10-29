import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { submitHumanAction } from '../api/client.js';
import { readHumanControl } from '../domain/human-control.js';
import type { HumanAction } from '../../shared/human-player.js';
import type { Route } from '../domain/types.js';
import type { useWatchRoom } from './useWatchRoom.js';

export function useHumanPlay(watch: ReturnType<typeof useWatchRoom>, route: Route, dealStage: string) {
  const replay = watch.replay;
  const player = replay?.room.players.find((candidate) => candidate.kind === 'human');
  const roomId = route.kind === 'room' ? route.id : '';
  const grant = useMemo(() => roomId ? readHumanControl(roomId) : null, [roomId, player?.id]);
  const owned = Boolean(grant && grant.playerId === player?.id && grant.seat === player?.seat);
  const snapshot = replay?.snapshots[watch.index];
  const decision = replay?.session.decision;
  const context = roomId + ':' + replay?.generation + ':' + decision?.id + ':' + watch.followLive;
  const gameKey = roomId + ':' + replay?.generation;
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const currentContext = useRef(context);
  const currentGame = useRef(gameKey);
  currentContext.current = context;
  currentGame.current = gameKey;
  useEffect(() => { setSelected(new Set()); setError(''); }, [context]);
  useEffect(() => { setBusy(false); return () => { controller.current?.abort(); controller.current = null; pending.current = false; }; }, [gameKey]);
  const enabled = Boolean(owned && decision?.kind === 'human' && decision.seat === grant?.seat && snapshot?.currentSeat === grant?.seat
    && snapshot.phase !== 'finished' && watch.followLive && watch.index === (replay?.snapshots.length ?? 0) - 1
    && replay?.room.status !== 'closed' && !watch.loading && !watch.busy && !dealStage);
  const selectable = enabled && !busy && snapshot?.phase === 'playing';
  const toggle = useCallback((id: string) => {
    if (!selectable) return;
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, [selectable]);
  const clear = useCallback(() => { setSelected(new Set()); setError(''); }, []);
  async function submit(action: HumanAction) {
    if (!enabled || !grant || !replay || !decision?.id || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    const requestContext = context;
    const activeController = new AbortController();
    controller.current = activeController;
    try {
      const update = await submitHumanAction(roomId, grant.token, { generation: replay.generation, decisionId: decision.id, action }, activeController.signal);
      if (!activeController.signal.aborted && currentGame.current === gameKey) watch.dispatch({ type: 'update', update });
    } catch (failure) {
      if (!activeController.signal.aborted && currentContext.current === requestContext) setError(failure instanceof Error ? failure.message : '操作失败');
    } finally { if (controller.current === activeController) { pending.current = false; setBusy(false); controller.current = null; } }
  }
  return { owned, seat: owned ? grant!.seat : undefined, selected, selectable, enabled: enabled && !busy, busy, error, toggle, clear,
    submit, phase: snapshot?.phase, callScore: snapshot?.logs.reduce((highest, entry) => entry.action === 'call' ? Math.max(highest, entry.score ?? 0) : highest, 0) ?? 0, canPass: Boolean(snapshot?.lastPlay),
    waiting: decision?.kind === 'human', followLive: watch.followLive };
}
