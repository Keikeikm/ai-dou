import { useCallback, useRef, useState } from 'react';
import type { BluffReveal, BluffRoomView } from '../../shared/bluff.js';

/** Buffer live updates during a reveal so hand counts and logs cannot spoil it. */
export function useBluffPresentation() {
  const [room, setRoom] = useState<BluffRoomView | null>(null);
  const [reveal, setReveal] = useState<{ key: number; result: BluffReveal; endedGame: boolean } | null>(null);
  const latest = useRef<BluffRoomView | null>(null);
  const revealing = useRef(false);
  const sequence = useRef(0);
  const update = useCallback((value: BluffRoomView) => {
    const previous = latest.current;
    const sameGame = previous?.id === value.id && previous.generation === value.generation;
    if (previous?.id === value.id && (previous.generation > value.generation || sameGame && previous.revision > value.revision)) return;
    if (sameGame && previous.revision === value.revision && previous.revealPending === null && value.revealPending != null) return;
    latest.current = value;
    if (!sameGame) {
      revealing.current = false;
      setReveal(null);
      setRoom(value);
      return;
    }
    const event = value.history.findLast((item) => item.sequence > previous.revision && item.reveal);
    if (event?.reveal && !revealing.current) {
      revealing.current = true;
      setReveal({ key: ++sequence.current, result: event.reveal, endedGame: value.phase === 'finished' && event.sequence === value.revision });
    }
    if (!revealing.current) setRoom(value);
  }, []);
  const finishReveal = useCallback(() => {
    revealing.current = false;
    setReveal(null);
    setRoom(latest.current);
  }, []);
  const replayReveal = useCallback(() => {
    if (!latest.current?.lastReveal || revealing.current) return;
    revealing.current = true;
    setReveal({ key: ++sequence.current, result: latest.current.lastReveal,
      endedGame: latest.current.phase === 'finished' && latest.current.history.at(-1)?.type === 'challenge' });
  }, []);
  const latestRoom = useCallback(() => latest.current, []);
  return { room, reveal, revealing, update, finishReveal, replayReveal, latestRoom };
}
