import { useEffect, useRef, useState } from 'react';
import { actionText, latestAction, profiles, responseFailure } from '../domain/presentation.js';
import type { Replay } from '../domain/types.js';
import { ModelCacheSummary, ModelResponsePanel, SourceBadge } from './ModelResponse.js';

export function History({ replay, index, followLive, seek, responseOpen = false }: { replay: Replay; index: number; followLive: boolean; seek: (index: number) => void; responseOpen?: boolean }) {
  const [filter, setFilter] = useState('all');
  const list = useRef<HTMLElement>(null);
  useEffect(() => { if (followLive && list.current) list.current.scrollTop = list.current.scrollHeight; }, [replay.turns.length, followLive]);
  const steps = replay.snapshots.map((snapshot, step) => ({ snapshot, step, turn: replay.turns[step - 1], action: latestAction(snapshot) }))
    .filter(({ action, turn }) => filter === 'all' || (filter === 'fallback' ? turn?.source === 'fallback' : action?.action === filter));
  return <aside className="history-panel" aria-label="牌局历史">
    {responseOpen && <ModelCacheSummary turns={replay.turns} />}
    {responseOpen && <ModelResponsePanel turn={replay.turns[index - 1]} snapshot={replay.snapshots[index]} room={replay.room} expanded />}
    <div className="history-heading"><h2>牌局历史</h2><span>{replay.turns.length} 步</span></div><p className="history-hint">点击任一步回看，仅影响当前观众</p>
    <div className="history-tools"><label htmlFor="history-filter">筛选</label><select id="history-filter" value={filter} onChange={(event) => setFilter(event.target.value)}>
      <option value="all">全部动作</option><option value="call">叫分</option><option value="play">出牌</option><option value="pass">不出</option><option value="fallback">系统托管</option>
    </select><button onClick={() => list.current?.querySelector('[aria-current="step"]')?.scrollIntoView?.({ block: 'nearest' })}>定位当前步</button></div>
    <nav ref={list} className="history-list" aria-label="历史步骤">{steps.map(({ snapshot, step, turn, action }) => <button key={step}
      className={'history-step' + (action ? ' ' + profiles[action.seat].theme : '') + (step === index ? ' selected' : '')}
      aria-label={'第 ' + step + ' 步 · ' + actionText(snapshot)} aria-current={step === index ? 'step' : 'false'} onClick={() => seek(step)}>
      <span className="history-sequence">{String(step).padStart(2, '0')}</span><span className="history-action">{actionText(snapshot)}</span>
      {turn && <SourceBadge turn={turn} room={replay.room} />}{turn?.source === 'fallback' && <span className="history-fallback">{responseFailure(turn.modelResponse, turn.reason)}</span>}
      {snapshot.phase === 'finished' && <span className="history-finish">{snapshot.winner === 'landlord' ? '地主胜利' : '农民胜利'}</span>}
    </button>)}</nav>{!steps.length && <p className="history-hint">暂无匹配动作</p>}
    {!responseOpen && <ModelResponsePanel turn={replay.turns[index - 1]} snapshot={replay.snapshots[index]} room={replay.room} />}
  </aside>;
}
