import type { useHumanPlay } from '../hooks/useHumanPlay.js';

export function HumanActions({ human }: { human: ReturnType<typeof useHumanPlay> }) {
  const description = !human.followLive ? '历史回看中，返回实时后才能操作' : human.phase === 'finished' ? '本局已结束'
    : human.enabled ? human.phase === 'calling' ? '你的回合 · 请选择叫分' : '你的回合 · 已选 ' + human.selected.size + ' 张' : human.busy ? '正在提交操作…' : '等待对手 / 开始对局';
  return <section className="human-actions" aria-label="真人操作"><strong>{description}</strong>
    <div className="human-buttons">{human.phase === 'calling' ? ([0, 1, 2, 3] as const).map((score) => <button key={score}
      disabled={!human.enabled || (score !== 0 && score <= human.callScore)} onClick={() => void human.submit({ type: 'call', score })}>{score ? '叫 ' + score + ' 分' : '不叫'}</button>)
      : <><button className="primary" disabled={!human.enabled || !human.selected.size || human.phase !== 'playing'} onClick={() => void human.submit({ type: 'play', cards: [...human.selected] })}>出牌</button>
        <button disabled={!human.enabled || !human.canPass || human.phase !== 'playing'} onClick={() => void human.submit({ type: 'pass' })}>不出</button>
        <button disabled={!human.selected.size || human.busy} onClick={human.clear}>取消选择</button></>}
    </div>{human.error && <p className="human-error" role="alert">{human.error}</p>}
  </section>;
}
