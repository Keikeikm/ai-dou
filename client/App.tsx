import { Component, lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import { parseRoute, type Route } from './domain/types.js';
import { useWatchRoom } from './hooks/useWatchRoom.js';
import { useDealAnimation } from './hooks/useDealAnimation.js';
import { ProviderPanel, Registration, KeySettings } from './components/AgentSettings.js';
import { Records, RoomTools } from './components/RoomTools.js';
import { RoomDrawer } from './components/RoomDrawer.js';
import { Lobby } from './components/Lobby.js';
import { Table } from './components/Table.js';
import { History } from './components/History.js';
import { Settlement } from './components/Settlement.js';
import { ReplayTools, WatchControls } from './components/WatchControls.js';
import { GameIcon } from './components/GameIcon.js';
import { useHumanPlay } from './hooks/useHumanPlay.js';

const ReplayAnalysis = lazy(() => import('./components/ReplayAnalysis.js'));
class AnalysisBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p role="alert">复盘分析加载失败，请关闭后重试或刷新页面。</p> : this.props.children; }
}
type Panel = 'settings' | 'history' | 'response' | 'replay' | 'analysis' | null;
const panelTitles = { settings: '房间设置', history: '出牌记录', response: '模型返回', replay: '回放与日志', analysis: '复盘分析' };

export function App({ route = parseRoute(window.location.pathname), navigate = (path: string) => window.location.assign(path) }: { route?: Route; navigate?: (path: string) => void }) {
  const watch = useWatchRoom(route);
  const stage = useDealAnimation(watch.replay, watch.followLive);
  const human = useHumanPlay(watch, route, stage);
  const [dismissed, setDismissed] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  useEffect(() => setDismissed(false), [watch.index, watch.replay?.generation]);
  useEffect(() => setPanel(null), [route.kind, route.kind === 'home' ? '' : route.id, watch.replay?.generation]);
  const archived = route.kind === 'archive';
  const replay = watch.replay;
  const snapshot = replay?.snapshots[watch.index];
  const seek = (index: number) => watch.dispatch({ type: 'seek', index });
  const review = () => watch.dispatch({ type: 'play', fromStart: true });
  const inspect = useCallback((index: number) => { watch.dispatch({ type: 'seek', index }); setPanel('response'); }, [watch.dispatch]);
  const settings = useCallback(() => setPanel('settings'), []);
  return <div className={'room' + (route.kind === 'home' ? ' home' : '') + (human.owned ? ' human-room' : '')}>
    <header className="room-header"><a className="brand" href="/" aria-label="AI DOU 首页"><span className="brand-icon" aria-hidden="true">♠</span><span>AI DOU</span></a>
      <div className="room-context">{route.kind !== 'home' && <a className="back-to-lobby" href="/">‹ 返回大厅</a>}<span className="session">{replay ? (archived ? '归档回放 · ' : '') + '第 ' + replay.generation + ' 局' : ''}</span>
        {replay && !archived && <span className={'connection' + (watch.connected ? ' connected' : '')}>{replay.room.status === 'closed' ? '房间已关闭' : watch.connected ? '实时连接' : '正在连接'}</span>}</div>
      {!archived && <button className="quiet header-settings" onClick={settings}><GameIcon name="settings" />设置</button>}</header>
    {route.kind === 'home' ? <Lobby navigate={navigate} /> : <>
      {watch.error && <div className="load-error" role="alert"><strong>操作或加载失败</strong><p>{watch.error}</p><button onClick={watch.reload}>重新加载</button><a href="/">返回首页</a></div>}
      {watch.loading && !replay && <div className="room-loading" role="status">正在连接棋牌室…</div>}
      {replay && <><Table key={replay.room.id + ':' + replay.generation} replay={replay} snapshot={snapshot} index={watch.index} followLive={watch.followLive}
        dealStage={stage} connected={watch.connected && !archived} inspect={inspect} settings={settings} human={human}>
        {snapshot?.phase === 'finished' && !dismissed && <Settlement snapshot={snapshot} replay={replay} archived={archived} busy={watch.busy} review={review}
          restart={() => void watch.control('new-game')} dismiss={() => setDismissed(true)} retry={() => void watch.control('settle')} />}
      </Table><WatchControls watch={watch} route={route} dealStage={stage} open={setPanel} human={human} /></>}
    </>}
    {panel && <RoomDrawer title={panelTitles[panel]} wide={panel === 'analysis'} close={() => setPanel(null)}>
      {panel === 'settings' && !archived && <><ProviderPanel />{replay && <><Registration room={replay.room} reload={watch.reload} /><KeySettings room={replay.room} reload={watch.reload} />
        <RoomTools room={replay.room} busy={watch.busy} close={() => void watch.control('close')} /><Records roomId={replay.room.id} /></>}
        <p className="privacy-note">翻牌只改变当前观众的显示。模型每轮仅收到自己的手牌、其他席位的剩余张数以及公开信息。</p></>}
      {(panel === 'history' || panel === 'response') && replay && <><History replay={replay} index={watch.index} followLive={watch.followLive} seek={seek} responseOpen={panel === 'response'} />
        {!archived && <button disabled={watch.followLive || !snapshot} onClick={() => watch.dispatch({ type: 'live' })}>返回实时</button>}</>}
      {panel === 'replay' && replay && <><ReplayTools watch={watch} route={route} dealStage={stage} /><button onClick={() => setPanel('analysis')}>打开 AVA 复盘分析</button><Records roomId={replay.room.id} /></>}
      {panel === 'analysis' && replay && <AnalysisBoundary><Suspense fallback={<p role="status">正在加载 AVA 分析引擎…</p>}>
        <ReplayAnalysis replay={replay} index={watch.index} source={route.kind === 'archive' ? { kind: 'archive', id: route.id } : { kind: 'room', id: replay.room.id }} seek={(step) => { seek(step); setPanel(null); }} />
      </Suspense></AnalysisBoundary>}
    </RoomDrawer>}
  </div>;
}
