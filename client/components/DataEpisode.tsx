import { useEffect, useMemo, useState } from 'react';
import { readEpisode, type EpisodeDetail } from '../api/game-data.js';
import { gameLabels, statusLabels } from '../../shared/game-data.js';
import type { BluffObservation } from '../../shared/bluff.js';
import type { GameSnapshot } from '../domain/types.js';
import type { AnalysisDataset } from '../domain/replay-analysis.js';
import { runAvaAnalysis } from '../domain/ava-analysis.js';
import { AnalysisChart } from './AnalysisChart.js';
import { RoomDrawer } from './RoomDrawer.js';
import { CardRow } from './Cards.js';

export function DataEpisode({ id, close }: { id: string; close: () => void }) {
  const [data, setData] = useState<EpisodeDetail | null>(null); const [error, setError] = useState(''); const [index, setIndex] = useState(0);
  useEffect(() => { const controller = new AbortController(); readEpisode(id, controller.signal).then((value) => { if (!controller.signal.aborted) setData(value); }).catch((e) => { if (!controller.signal.aborted) setError(e.message); }); return () => controller.abort(); }, [id]);
  return <RoomDrawer title="牌局档案 · 单局复盘" close={close} wide>{error && <p role="alert">{error}</p>}{!data && !error && <p role="status">正在还原牌局…</p>}{data && <EpisodeContent data={data} index={index} seek={setIndex} />}</RoomDrawer>;
}
function EpisodeContent({ data, index, seek }: { data: EpisodeDetail; index: number; seek: (i: number) => void }) {
  const { episode, snapshots } = data; const raw = episode.raw;
  const snapshot = snapshots[index]; const bluff = raw.game === 'bluff' ? snapshot as BluffObservation : null;
  const dd = raw.game === 'doudizhu' ? snapshot as GameSnapshot : null;
  const moves = raw.game === 'bluff' ? raw.steps : raw.journal.turns;
  const dataset = useMemo<AnalysisDataset>(() => ({ metric: 'hands', xLabel: '历史步骤', yLabel: '张', categorical: false, observations: snapshots.length * episode.players.length, missing: 0,
    points: snapshots.flatMap((s, i) => episode.players.map((p) => ({ x: i, y: 'hands' in s ? s.hands[p.seat].length : p.seat === 0 ? s.hand.length : s.opponentCount, series: p.name + ' · 席位 ' + (p.seat + 1), steps: [i] }))) }), [episode, snapshots]);
  const ava = useMemo(() => runAvaAnalysis(dataset), [dataset]);
  const player = (seat: number) => episode.players.find((p) => p.seat === seat)?.name ?? '玩家';
  const action = moves[index - 1];
  return <section className="data-episode"><span className="game-kicker">{gameLabels[episode.game]} / 第 {episode.generation} 局 / {statusLabels[episode.status]}</span><h3>{episode.players.map((p) => p.name).join(' × ')}</h3><p className="data-note">{episode.status === 'finished' ? episode.players.filter((p) => p.won).map((p) => p.name).join('、') + '获胜。' : '这是一局未完成的档案，没有胜负标签。'} 下方回放从保存的动作还原，不调用模型。{episode.game === 'bluff' && (episode.rulesVersion === 'bluff-sequential-52-v1' ? '本局使用旧版规则：回应者出下一手。' : '本局规则：质疑赢家出下一手。')}</p>
    <div className="data-replay-controls"><button disabled={!index} onClick={() => seek(index - 1)}>上一步</button><label>回放步骤<input type="range" min={0} max={snapshots.length - 1} value={index} onChange={(e) => seek(Number(e.target.value))} /></label><b>{index} / {snapshots.length - 1}</b><button disabled={index === snapshots.length - 1} onClick={() => seek(index + 1)}>下一步</button></div>
    <div className="data-snapshot"><strong>{action ? player(action.seat) + ' · ' + actionText(action.action) : '初始发牌'}</strong>{bluff && <><p>本轮点数 {bluff.rank} · 牌堆 {bluff.pileCount} 张 · {bluff.phase === 'finished' ? '对局结束' : '轮到' + player(bluff.turn) + (bluff.phase === 'respond' ? '回应' : '出牌')}</p><p>{player(0)}剩 {bluff.hand.length} 张 / {player(1)}剩 {bluff.opponentCount} 张</p><CardRow cards={bluff.hand} hand />{bluff.claim && <p>{player(bluff.claim.seat)}声称：{bluff.claim.count} 张 {bluff.claim.rank}</p>}{bluff.history.at(-1)?.type === 'challenge' && bluff.lastReveal && <div><p>{bluff.lastReveal.lied ? '抓到假牌！' : '说的是真话。'} {player(bluff.lastReveal.loser)}收走 {bluff.lastReveal.collected} 张。</p><CardRow cards={bluff.lastReveal.cards} /></div>}</>}
      {dd && <><p>{dd.phase === 'finished' ? '对局结束' : '轮到' + player(dd.currentSeat)} · {dd.landlord >= 0 ? player(dd.landlord) + '是地主' : '叫地主阶段'}</p>{dd.hands.map((hand, seat) => <div key={seat}><p>{player(seat)} · {hand.length} 张</p><CardRow cards={hand} hand /></div>)}</>}</div>
    <div className="data-section-title"><h3>手牌变化</h3><span className="analysis-badge">AntV AVA</span></div><AnalysisChart dataset={dataset} type={ava.recommendations[0]?.type ?? 'line_chart'} seek={seek} />
    {ava.insights.length > 0 && <ul className="data-replay-insights">{ava.insights.map((insight, i) => <li key={i}>{insight.text}{insight.steps.length > 0 && <button onClick={() => seek(insight.steps[0])}>查看</button>}</li>)}</ul>}
    <details><summary>全部动作 · {moves.length} 步</summary><ol className="data-move-list">{moves.map((move, i) => <li key={i}><button onClick={() => seek(i + 1)} aria-current={index === i + 1 ? 'step' : undefined}>第 {i + 1} 步 · {player(move.seat)} · {actionText(move.action)} <small>{move.source === 'fallback' ? '系统兜底' : move.source === 'human' ? '真人' : 'AI'}</small></button></li>)}</ol></details>
  </section>;
}
function actionText(action: { type: string; cards?: readonly unknown[]; score?: number }) { return action.type === 'play' ? '出 ' + action.cards?.length + ' 张牌' : action.type === 'call' ? '叫 ' + action.score + ' 分' : action.type === 'pass' ? '不出' : action.type === 'accept' ? '相信' : '质疑'; }
