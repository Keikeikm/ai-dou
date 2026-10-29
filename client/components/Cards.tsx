import { memo, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import type { Card } from '../domain/types.js';
import { ranks } from '../domain/presentation.js';

const symbols: Record<string, string> = { spades: '♠', hearts: '♥', clubs: '♣', diamonds: '♦', joker: '★' };

export interface CardSelection {
  readonly selected: ReadonlySet<string>;
  readonly enabled: boolean;
  readonly toggle: (id: string) => void;
}

export function PlayingCard({ card, hidden, hiddenLabel = '未公开的底牌', delay = 0, selection }: { card?: Card; hidden?: boolean; hiddenLabel?: string; delay?: number; selection?: CardSelection }) {
  const red = !hidden && (card?.suit === 'hearts' || card?.suit === 'diamonds' || card?.rank === 'big-joker');
  const joker = !hidden && card?.suit === 'joker';
  const rank = joker ? card?.rank === 'big-joker' ? '大王' : '小王' : card?.rank;
  const selected = Boolean(card && selection?.selected.has(card.id));
  const className = 'card' + (hidden ? ' back' : red ? ' red' : '') + (joker ? ' joker' : '') + (!hidden && rank === '10' ? ' ten' : '') + (selected ? ' selected' : '');
  const style = { '--deal-delay': delay + 'ms' } as CSSProperties;
  const content = !hidden && <><span className="card-corner">{rank}<span className="suit">{symbols[card?.suit ?? 'joker']}</span></span><span className="card-center">{joker ? '♛' : symbols[card?.suit ?? 'joker']}</span></>;
  return selection && card && !hidden ? <button type="button" className={className} style={style} aria-label={card.display} aria-pressed={selected}
    disabled={!selection.enabled} onClick={() => selection.toggle(card.id)}>{content}</button>
    : <span className={className} role="img" aria-label={hidden ? hiddenLabel : card?.display} style={style}>{content}</span>;
}

interface CardRowProps {
  cards: readonly Card[];
  hidden?: boolean;
  hiddenLabel?: string;
  hand?: boolean;
  animate?: boolean;
  step?: number;
  selection?: CardSelection;
}

export const CardRow = memo(function CardRow({ cards, hidden, hiddenLabel = '盖住的手牌', hand, animate, step, selection }: CardRowProps) {
  const row = useRef<HTMLDivElement>(null);
  const previousStep = useRef(step);
  useEffect(() => {
    const before = previousStep.current;
    previousStep.current = step;
    if (!animate || before === undefined || step !== before + 1 || !row.current?.animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const animation = row.current.animate([{ transform: 'translateY(-12px)', opacity: .6 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 260, easing: 'ease-out' });
    return () => animation.cancel();
  }, [step, animate]);
  const sorted = useMemo(() => hand ? [...cards].sort((left, right) => ranks.indexOf(right.rank) - ranks.indexOf(left.rank)) : cards, [cards, hand]);
  return <div ref={row} className={'card-row' + (hand ? ' hand-row' : '') + (selection ? ' selectable-row' : '')}>
    {sorted.map((card, position) => <PlayingCard key={card.id} card={card} hidden={hidden} hiddenLabel={hiddenLabel} delay={Math.min(520, position * 25)} selection={selection} />)}
  </div>;
}, (previous, next) => previous.hidden === next.hidden && previous.hiddenLabel === next.hiddenLabel && previous.hand === next.hand && previous.animate === next.animate && previous.step === next.step
  && previous.selection?.enabled === next.selection?.enabled && previous.selection?.selected === next.selection?.selected && previous.selection?.toggle === next.selection?.toggle
  && previous.cards.length === next.cards.length && previous.cards.every((card, index) => {
    const other = next.cards[index];
    return card.id === other.id && card.rank === other.rank && card.suit === other.suit && card.display === other.display;
  }));
