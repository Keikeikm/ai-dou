import { useEffect, useState } from 'react';
import type { Session } from '../domain/types.js';

export function useDecisionClock(session: Session | undefined, enabled: boolean) {
  const [now, setNow] = useState(Date.now());
  const [offset, setOffset] = useState(0);
  useEffect(() => { if (session?.serverTime) setOffset(session.serverTime - Date.now()); }, [session?.serverTime]);
  useEffect(() => {
    if (!enabled || !session?.decision) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [enabled, session?.decision?.sequence]);
  return enabled && session?.decision ? Math.max(0, session.decision.deadline - now - offset) : null;
}
