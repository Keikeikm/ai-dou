import { memo } from 'react';
import type { Session } from '../domain/types.js';
import { useDecisionClock } from '../hooks/useDecisionClock.js';

export const DecisionClock = memo(function DecisionClock({ session, enabled, model }: { session: Session; enabled: boolean; model: boolean }) {
  const remaining = useDecisionClock(session, enabled);
  return <div className="decision-clock-slot">{remaining !== null && <span className="decision-clock" role="status">{remaining > 0
    ? (session.decision?.kind === 'human' ? '等待真人操作' : model ? '模型请求中' : 'Agent 计算中') + ' · ' + (remaining / 1000).toFixed(1) + 's' : '等待服务端托管'}</span>}</div>;
});
