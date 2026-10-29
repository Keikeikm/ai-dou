import { profiles, signedScore } from '../domain/presentation.js';
import type { GameSnapshot, Replay } from '../domain/types.js';

export function Settlement({ snapshot, replay, archived, busy, review, restart, dismiss, retry }: {
  snapshot: GameSnapshot; replay: Replay; archived: boolean; busy: boolean; review: () => void; restart: () => void; dismiss: () => void; retry: () => void;
}) {
  const settlement = snapshot.settlement;
  if (!settlement) return null;
  return <div className="result-overlay"><section className="result-panel" aria-label="对局结果">
    <span className="result-emblem" aria-hidden="true">♛</span><p className="eyebrow">本局已结束</p><h1>{snapshot.winner === 'landlord' ? '地主胜利！' : '农民胜利！'}</h1>
    <div className="result-factors">基础分 {settlement.baseScore} · 叫分 ×{settlement.callMultiplier} · 炸弹 ×{settlement.bombMultiplier} · 春天 ×{settlement.springMultiplier} · 总倍数 ×{settlement.totalMultiplier}</div>
    <p className="result-unit">单位分 {settlement.unitScore}</p><div className="result-summary">{settlement.players.map((player) => {
      const entry = replay.accounting?.entries.find((candidate) => candidate.seat === player.seat);
      return <div key={player.seat} className={'result-player ' + profiles[player.seat].theme}><img src={profiles[player.seat].avatar} alt="" /><strong>{profiles[player.seat].name}</strong><span>{signedScore(player.delta)}</span>
        {entry && <small>{entry.beforeScore} → {entry.afterScore}</small>}</div>;
    })}</div>
    <p role="status">{replay.accounting?.status === 'recorded' ? '已入账 · 回放不会重复计分' : '结算尚未入账'}</p>
    {replay.accounting?.status === 'error' && !archived && <button disabled={busy} onClick={retry}>重试结算入账</button>}
    <p className="result-note">娱乐积分 · 三人积分变化之和为 0 · 非现金</p><div className="result-actions"><button className="primary" onClick={review}>回放本局</button>
      {!archived && <button disabled={busy || replay.room.status === 'closed'} onClick={restart}>随机再来一局</button>}<button onClick={dismiss}>查看牌桌</button></div>
  </section></div>;
}
