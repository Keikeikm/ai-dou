import { actionText, origin } from '../domain/presentation.js';
import type { Route } from '../domain/types.js';
import type { useWatchRoom } from '../hooks/useWatchRoom.js';
import { SourceBadge } from './ModelResponse.js';
import { GameIcon } from './GameIcon.js';
import { HumanActions } from './HumanActions.js';
import type { useHumanPlay } from '../hooks/useHumanPlay.js';

type Watch = ReturnType<typeof useWatchRoom>;

export function WatchControls({ watch, route, dealStage, open, human }: { watch: Watch; route: Route; dealStage: string; open: (panel: 'history' | 'response' | 'replay' | 'analysis') => void; human?: ReturnType<typeof useHumanPlay> }) {
  const replay = watch.replay;
  if (!replay) return null;
  const archived = route.kind === 'archive';
  const snapshot = replay.snapshots[watch.index];
  const missingKey = replay.room.players.some((player) => player.kind === 'deepseek' && !player.hasApiKey);
  const canOperate = route.kind === 'room' && replay.room.status !== 'closed' && !watch.busy && !human?.busy && !dealStage && !watch.loading;
  function toggle() {
    if (!watch.followLive || archived || replay!.session.status === 'finished') watch.dispatch({ type: watch.playing ? 'pause' : 'play' });
    else void watch.control(replay!.session.status === 'running' ? 'pause' : 'start');
  }
  return <footer className={'watchbar' + (human?.owned ? ' human-watchbar' : '')}>
    {human?.owned && <HumanActions human={human} />}
    <div className="watchbar-row">
    <div className="current-event"><SourceBadge turn={replay.turns[watch.index - 1]} room={replay.room} /><p>{actionText(snapshot)}</p>
      <small role="status"><span>{archived ? '归档回放 · 只读' : watch.followLive ? human?.owned ? '实时对战' : '实时观战' : watch.playing ? '本地回放中' : '历史回看'}</span> · {watch.index} / {Math.max(0, replay.snapshots.length - 1)}</small></div>
    <div className="watch-actions"><button className="primary" disabled={!snapshot || watch.busy || human?.busy || Boolean(dealStage) || (watch.followLive && !archived && (missingKey || !canOperate))} onClick={toggle}>
      <GameIcon name={(!watch.followLive || archived ? watch.playing : replay.session.status === 'running') ? 'pause' : 'play'} />
      {!watch.followLive || archived ? watch.playing ? '暂停回放' : '播放回放' : replay.session.status === 'running' ? '暂停对局'
        : replay.session.status === 'finished' ? '回放本局' : replay.turns.length ? '继续对局' : human?.owned ? '开始对局' : '开始观战'}</button>
      {!archived && <button className="new-game" disabled={!canOperate || !snapshot} onClick={() => void watch.control('new-game')}><GameIcon name="cards" />随机新局</button>}
      <button className="quiet" onClick={() => open('history')}><GameIcon name="history" />出牌记录</button><button className="quiet" onClick={() => open('response')}><GameIcon name="response" />模型返回</button>
      <button className="quiet" onClick={() => open('replay')}><GameIcon name="replay" />回放与日志</button>
      <button className="quiet" onClick={() => open('analysis')}><GameIcon name="history" />复盘分析</button>
    </div></div>
  </footer>;
}

export function ReplayTools({ watch, route, dealStage }: { watch: Watch; route: Route; dealStage: string }) {
  const replay = watch.replay;
  if (!replay) return null;
  const archived = route.kind === 'archive';
  const snapshot = replay.snapshots[watch.index];
  const lastIndex = Math.max(0, replay.snapshots.length - 1);
  const missingKey = replay.room.players.some((player) => player.kind === 'deepseek' && !player.hasApiKey);
  const canStep = route.kind === 'room' && replay.room.status !== 'closed' && !watch.busy && !dealStage && !watch.loading && !missingKey && watch.followLive && ['idle', 'paused'].includes(replay.session.status);
  const totals: Record<string, number> = { model: 0, bot: 0, http: 0, human: 0, fallback: 0, unknown: 0 };
  for (const turn of replay.turns.slice(0, watch.index)) totals[origin(turn, replay.room).kind] += 1;
  return <section className="replay-tools" aria-label="回放控制"><p>当前 {watch.index} / {lastIndex} · 最新 {lastIndex} 步</p>
    <div className="watch-tools"><button disabled={lastIndex < 1} onClick={() => watch.dispatch({ type: 'play', fromStart: true })}>从头回放</button>
      {!archived && <button disabled={watch.followLive || !snapshot} onClick={() => watch.dispatch({ type: 'live' })}>返回实时</button>}
      <button disabled={watch.index === 0 || watch.busy} onClick={() => watch.dispatch({ type: 'seek', index: watch.index - 1 })}>上一步</button>
      <button disabled={watch.busy || Boolean(dealStage) || (watch.index === lastIndex && !canStep)} onClick={() => watch.index < lastIndex
        ? watch.dispatch({ type: 'seek', index: watch.index + 1 }) : void watch.control('step')}>{watch.index === lastIndex && canStep ? '推进对局一步' : '下一步'}</button>
      <label htmlFor="playback-speed">回放速度</label><select id="playback-speed" value={watch.speed} onChange={(event) => watch.setSpeed(Number(event.target.value))}>
        {[0.5, 1, 2, 4].map((speed) => <option key={speed} value={speed}>{speed}×</option>)}</select></div>
    <p>本地回放和历史跳转仅影响当前观众，不重新发牌或调用模型。</p>
    <p>当前步累计 · 模型 {totals.model} · Bot {totals.bot} · HTTP {totals.http} · 真人 {totals.human} · 托管 {totals.fallback}</p>
    <a href={archived ? '/api/games/' + route.id + '/journal' : '/api/rooms/' + replay.room.id + '/journal'} download>导出对局日志</a>
    <p><a href="/spectating" target="_blank" rel="noopener">观战说明</a></p>
  </section>;
}
