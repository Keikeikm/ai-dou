import { memo } from 'react';
import type { Card, Player, TurnRecord } from '../domain/types.js';
import { profiles } from '../domain/presentation.js';
import { CardRow, type CardSelection } from './Cards.js';
import { SourceBadge } from './ModelResponse.js';
import { strategySkills } from '../../shared/strategy-skills.js';

export const Seat = memo(function Seat({ seat, player, hand, current, active, visible, disabled, role, speech, lastTurn, phase, flip, selection, concealed }: {
  seat: number; player?: Player; hand: readonly Card[]; current: boolean; active: boolean; visible: boolean; disabled: boolean;
  role: string; speech: string; lastTurn?: TurnRecord; phase?: string; flip: (seat: number) => void;
  selection?: CardSelection; concealed?: boolean;
}) {
  const profile = profiles[seat];
  const kind = player?.kind === 'human' ? 'human' : player?.kind === 'deepseek' ? 'model' : player?.kind === 'http' ? 'http' : !player || player.kind === 'archived' ? 'unknown' : 'bot';
  const badge = kind === 'human' ? '真人玩家' : kind === 'model' ? 'DeepSeek 模型' : kind === 'http' ? 'HTTP Agent' : kind === 'bot' ? '内置 Bot' : player ? '归档席位' : '待入座';
  const strategy = lastTurn?.modelResponse?.strategy ?? strategySkills.find((skill) => skill.id === player?.skill);
  return <section className={'seat seat-' + seat + ' ' + profile.theme + (active ? ' active' : '')} aria-label={profile.name + ' ' + (seat + 1) + ' 号席位'} aria-current={active ? 'true' : 'false'}>
    <div className="seat-header"><div className="portrait"><img className="avatar-art" src={profile.avatar} alt={profile.name + ' Q版角色'} /><span className="seat-number">{seat + 1}</span>
      {active && <span className="portrait-turn">{phase === 'calling' ? '叫分中' : '出牌中'}</span>}</div>
      <div className="identity"><div className="profile-label">{profile.name}<span className={role === '地主' ? 'role landlord' : 'role'}>{role}</span></div>
        <div className="strategy"><span title={strategy ? strategy.name + ' v' + strategy.version : undefined}>{strategy?.name ?? player?.model ?? player?.name ?? '空席位'}</span><small>{strategy && player?.model ? player.model + ' · ' : ''}积分 {player?.score ?? 0}</small></div>
        <div className="seat-origin"><span className={'source-badge source-' + kind}>{badge}</span><SourceBadge turn={lastTurn} /></div>
        <div className={'seat-status' + (active ? ' turn-badge' : '')}>{speech}</div>
      </div>
    </div>
    <div className="hand-area"><div className="hand-meta"><span>{profile.name}的手牌</span><span className={'count' + (hand.length <= 2 && phase === 'playing' ? ' warning' : '')}>{phase ? '剩余 ' + hand.length + ' 张' : '尚未发牌'}</span></div>
      <div className="hand-frame">{selection ? <div className="hand-toggle" aria-label="你的手牌"><CardRow cards={hand} hand selection={selection} /></div>
        : <button className="hand-toggle" disabled={current || disabled || concealed || !hand.length} aria-label={current ? profile.name + '当前行动方的手牌' : (visible ? '盖住' : '翻开') + profile.name + '的手牌'}
        aria-pressed={visible} onClick={() => flip(seat)}>
        <CardRow cards={hand} hand hidden={!visible} hiddenLabel={profile.name + '的盖住手牌'} />
      </button>}{!hand.length && <span className="empty-hand">{phase ? '已出完手牌' : '入座后发牌'}</span>}</div>
      <span className="hand-hint">{selection ? selection.enabled ? '点击选牌 · 可组合多张出牌' : '你的手牌 · 等待操作回合' : concealed ? '对手手牌 · 对战中隐藏' : current ? '当前行动方 · 自动展开' : visible ? '已展开 · 点击盖住' : '已盖住 · 点击翻开'}</span>
    </div>
  </section>;
});
