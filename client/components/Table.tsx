import { useCallback, useState, type ReactNode } from 'react';
import { combinationNames, latestAction, profiles, responseFailure } from '../domain/presentation.js';
import type { Card, GameSnapshot, Replay } from '../domain/types.js';
import { CardRow, PlayingCard } from './Cards.js';
import { DecisionClock } from './DecisionClock.js';
import { GameIcon } from './GameIcon.js';
import { Seat } from './Seat.js';
import type { useHumanPlay } from '../hooks/useHumanPlay.js';

const emptyCards: readonly Card[] = [];

export function Table({ replay, snapshot, index, followLive, dealStage, connected, inspect, settings, children, human }: {
  replay: Replay; snapshot?: GameSnapshot; index: number; followLive: boolean; dealStage: string; connected: boolean;
  inspect: (index: number) => void; settings: () => void; children?: ReactNode;
  human?: ReturnType<typeof useHumanPlay>;
}) {
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set([0, 1, 2]));
  const action = latestAction(snapshot);
  const playView = Boolean(human?.owned && snapshot?.phase !== 'finished');
  const visibleTurns = replay.turns.slice(0, index);
  const failed = visibleTurns.findLast((turn) => turn.source === 'fallback' && turn.decisionKind === 'model');
  const accepted = visibleTurns.some((turn) => turn.source === 'agent' && turn.decisionKind === 'model');
  const bombs = snapshot?.logs.filter((entry) => entry.action === 'play' && (entry.cards.length === 4 && entry.cards.every((card) => card.rank === entry.cards[0].rank)
    || entry.cards.length === 2 && entry.cards.every((card) => card.suit === 'joker'))).length ?? 0;
  const multiplier = snapshot?.settlement?.totalMultiplier ?? (snapshot?.callScore ?? 1) * 2 ** bombs;
  const phase = dealStage === 'shuffle' ? '洗牌动画' : dealStage ? '发牌动画' : !snapshot ? '等待入座 ' + replay.room.players.length + '/3'
    : snapshot.phase === 'calling' ? '叫地主' : snapshot.phase === 'playing' ? '出牌阶段' : '对局结束';
  const flip = useCallback((seat: number) => {
    setRevealed((previous) => {
      const next = new Set(previous);
      if (next.has(seat)) next.delete(seat); else next.add(seat);
      return next;
    });
  }, []);
  return <main className={'board' + (dealStage === 'shuffle' ? ' shuffling' : dealStage ? ' dealing' : '')} data-room-id={replay.room.id} aria-label="三人斗地主牌桌" aria-busy={Boolean(dealStage)}>
    <div className="table-bar"><span className="table-title"><GameIcon name="cards" />{replay.room.name}</span>
      <div className="table-hud"><span className="phase" role="status">{phase}</span><span>底分 <b>{replay.room.baseScore}</b></span><span>倍数 <b>× {multiplier}</b></span>
        <div className="bottom-area"><span>底牌</span><div className="bottom-cards">{snapshot?.bottomCards.map((card) => <PlayingCard key={card.id} card={card} hidden={snapshot.landlord < 0} />)}</div></div>
      </div><span className="table-view-hint">{playView ? '真人对战 · 只看自己的手牌' : '点击手牌 · 自选翻面'}</span></div>
    {failed && !accepted && <div className="table-diagnostic" role="alert"><div><strong>模型尚未成功决策，目前为系统托管</strong>
      <span>{responseFailure(failed.modelResponse, failed.reason)}</span></div><button onClick={() => inspect(failed.sequence)}>查看托管详情</button></div>}
    <div className="table-scene">{profiles.map((profile, seat) => {
      const player = replay.room.players.find((candidate) => candidate.seat === seat);
      const lastTurn = visibleTurns.findLast((turn) => turn.seat === seat);
      const current = snapshot?.currentSeat === seat;
      const active = Boolean(current && snapshot?.phase !== 'finished' && !dealStage);
      const role = snapshot && snapshot.landlord >= 0 ? snapshot.landlord === seat ? '地主' : '农民' : '待定';
      const speech = !snapshot ? player ? '已入座' : '等待 Agent 入座' : active ? snapshot.phase === 'calling' ? '当前叫分方' : '当前出牌方'
        : lastTurn?.action.type === 'call' && snapshot.phase === 'calling' ? lastTurn.action.score ? '叫 ' + lastTurn.action.score + ' 分' : '不叫'
        : action?.seat === seat && action.action === 'pass' ? '不出' : snapshot.phase === 'finished' ? '本局结束' : '等待出牌';
      return <Seat key={seat} seat={seat} player={player} hand={snapshot?.hands[seat] ?? emptyCards} current={current} active={active} visible={playView ? seat === human?.seat : current || revealed.has(seat)}
        disabled={Boolean(dealStage)} role={role} speech={human?.owned && seat === human.seat && active ? '你的回合' : speech} lastTurn={lastTurn} phase={snapshot?.phase} flip={flip}
        concealed={playView && seat !== human?.seat} selection={human?.owned && seat === human.seat ? { selected: human.selected, enabled: Boolean(human.selectable), toggle: human.toggle } : undefined} />;
    })}
      <section className="table-center" aria-label="当前出牌">
        <div className="trick-heading"><span>{snapshot?.lastPlay ? profiles[snapshot.lastPlay.seat].name + '出牌' : '桌面出牌'}</span>
          <strong>{snapshot?.lastPlay ? combinationNames[snapshot.lastPlay.type] ?? '出牌' : !snapshot ? '等待入座' : snapshot.phase === 'calling' ? '叫地主' : '新一轮'}</strong></div>
        <div className="trick-area"><CardRow cards={snapshot?.lastPlay?.cards ?? emptyCards} animate={action?.action === 'play'} step={followLive ? index : undefined} />
          {!snapshot?.lastPlay && <div className="trick-empty"><span aria-hidden="true">♠</span><small>{snapshot?.phase === 'playing' ? '等待首轮出牌' : '让智慧在牌桌上相遇'}</small></div>}</div>
        <div className={'turn-feedback' + (snapshot && snapshot.phase !== 'finished' && !dealStage ? ' turn-feedback-active' : '')} aria-live="polite">{snapshot ? snapshot.phase === 'finished' ? '本局已结束' : '轮到' + profiles[snapshot.currentSeat].name + (snapshot.phase === 'calling' ? '叫分' : '出牌') : '邀请 Agent 入座'}</div>
        <div className="last-action">{action?.action === 'pass' ? profiles[action.seat].name + ' · 不出' : '\u00a0'}</div>
        <DecisionClock session={replay.session} enabled={connected && followLive && replay.room.status !== 'closed'} model={replay.room.players.find((player) => player.seat === replay.session.decision?.seat)?.kind === 'deepseek'} />
        {!snapshot && <button onClick={settings}>配置入座席位</button>}
      </section>
    </div>
    {snapshot && !replay.turns.length && replay.room.players.some((player) => player.kind === 'deepseek') && <small className="table-fee">开始后将调用模型并产生 API 费用</small>}
    {dealStage && <div className="deal-overlay"><div className="shuffle-stack" aria-hidden="true">{[0, 1, 2, 3].map((position) => <PlayingCard key={position} hidden />)}</div>
      <strong role="status">{dealStage === 'shuffle' ? '洗牌中…' : '发牌中…'}</strong><small>动画仅作可视化，不调用模型</small></div>}
    {children}
  </main>;
}
