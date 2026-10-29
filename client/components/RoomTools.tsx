import { useEffect, useState } from 'react';
import { configuration, createRoom, roomGames } from '../api/client.js';
import { profiles, signedScore } from '../domain/presentation.js';
import type { AgentRegistration, GameSummary, Room } from '../domain/types.js';
import { defaultSkillForSeat } from '../../shared/strategy-skills.js';

export function RoomCreation({ navigate }: { navigate: (path: string) => void }) {
  const [baseScore, setBaseScore] = useState(1);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void configuration(controller.signal).then((config) => { setBaseScore(config.baseScore); setReady(true); })
      .catch((failure) => { if (!controller.signal.aborted) setMessage(failure.message); });
    return () => controller.abort();
  }, []);
  async function create(kind: 'bot' | 'deepseek' | 'empty' | 'human-bot' | 'human-deepseek') {
    if (pending || !ready) return;
    setPending(true);
    setMessage('');
    try {
      if (!Number.isInteger(baseScore) || baseScore < 1 || baseScore > 1000000) throw new Error('基础分应为 1 到 1000000 的整数');
      const model = kind === 'deepseek' || kind === 'human-deepseek';
      const human = kind.startsWith('human-');
      const players: AgentRegistration[] = kind === 'empty' ? [] : profiles.map((profile, seat) => human && seat === 1
        ? { name: '我', kind: 'human', seat }
        : { name: profile.name, kind: model ? 'deepseek' : seat === 0 ? 'random' : 'greedy', seat,
          ...(model ? { skill: defaultSkillForSeat(seat) } : {}) });
      const created = await createRoom(players, baseScore);
      navigate('/rooms/' + created.id);
    } catch (failure) { setMessage(failure instanceof Error ? failure.message : '建房失败'); }
    finally { setPending(false); }
  }
  return <div className="room-creation" aria-label="创建棋牌室">
    <div className="lobby-actions"><button className="primary" disabled={pending || !ready} onClick={() => void create('deepseek')}>AI对战</button>
      </div>
    <div className="human-room-entry"><div className="lobby-actions">
      <button disabled={pending || !ready} onClick={() => void create('human-deepseek')}>人类 VS AI</button>
      </div></div>
    {message && <p className="form-message" role="alert">{message}</p>}
    </div>

}

export function RoomTools({ room, busy, close }: { room: Room; busy: boolean; close: () => void }) {
  const [message, setMessage] = useState('');
  async function copy() {
    try { await navigator.clipboard.writeText(window.location.origin + room.viewUrl); setMessage('观战链接已复制'); }
    catch { setMessage('复制失败，请手动复制链接'); }
  }
  return <section className="room-tools" aria-label="房间管理"><h3>房间与分享</h3><div className="room-share">
    <label htmlFor="watch-link">观战链接</label><input id="watch-link" readOnly value={window.location.origin + room.viewUrl} />
    <button onClick={() => void copy()}>复制</button><button className="danger" disabled={busy || room.status === 'closed'} onClick={close}>关闭房间</button></div>
    <p className="room-meta" role="status">{message || room.players.length + '/3 玩家 · ' + room.spectators + ' 人观战'}</p>
    <p><a href="/human-play" target="_blank" rel="noopener">真人对战说明</a></p>
  </section>;
}

export function Records({ roomId }: { roomId: string }) {
  const [games, setGames] = useState<GameSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('点击查询已保存的结算与日志');
  async function load() {
    if (busy) return;
    setBusy(true);
    try { const result = await roomGames(roomId); setGames(result.games); setMessage(result.games.length ? '' : '本房还没有已入账的对局'); }
    catch (failure) { setMessage(failure instanceof Error ? failure.message : '查询失败'); }
    finally { setBusy(false); }
  }
  return <details className="record-panel"><summary>历次结算记录</summary><div className="record-tools"><button disabled={busy} onClick={() => void load()}>查询本房结算记录</button><span>最近 20 局 · <a href="/scoring" target="_blank" rel="noopener">积分规则</a></span></div><p role="status">{message}</p>
    {games.map((game) => <div key={game.gameId} className="record-row"><strong>第 {game.generation} 局 · 总倍数 ×{game.settlement.totalMultiplier}</strong>
      <span>{game.entries.map((entry) => entry.name + ' ' + signedScore(entry.delta) + '（' + entry.beforeScore + ' → ' + entry.afterScore + '）').join(' / ')}</span>
      <a href={'/api/games/' + game.gameId} target="_blank" rel="noopener">结算详情</a><a href={'/api/games/' + game.gameId + '/journal'} download>导出此局日志</a><a href={'/games/' + game.gameId} target="_blank" rel="noopener">回放此局</a>
    </div>)}
  </details>;
}
