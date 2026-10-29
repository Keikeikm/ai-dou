import { useEffect, useRef, useState } from 'react';
import type { Replay } from '../domain/types.js';

export function useDealAnimation(replay: Replay | null, followLive: boolean) {
  const [stage, setStage] = useState('');
  const seen = useRef('');
  const identity = replay ? replay.room.id + ':' + replay.generation : '';
  const eligible = followLive && replay?.room.status !== 'closed' && replay?.snapshots.length === 1 && replay.session.status === 'idle';
  useEffect(() => {
    if (!eligible || !replay) { setStage(''); return; }
    if (seen.current === identity) return;
    seen.current = identity;
    try {
      const storageKey = 'ai-dou:deal:' + replay.room.id;
      if (sessionStorage.getItem(storageKey) === String(replay.generation)) return;
      sessionStorage.setItem(storageKey, String(replay.generation));
    } catch {}
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    setStage('shuffle');
    const shuffleTimer = setTimeout(() => setStage('deal'), 650);
    const dealTimer = setTimeout(() => setStage(''), 1600);
    return () => { clearTimeout(shuffleTimer); clearTimeout(dealTimer); };
  }, [identity, eligible]);
  return stage;
}
