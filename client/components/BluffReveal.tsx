import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { BluffReveal as RevealResult } from '../../shared/bluff.js';
import { PlayingCard } from './Cards.js';

const name = (seat: number) => seat === 0 ? '你' : '鲸鱼娘';
const LEAD_IN = 720;
const CARD_GAP = 280;
const FLIP_TIME = 680;

/** Presentation only: this component never sends an action or decides a result. */
export function BluffReveal({ result, complete, endedGame = false }: { result: RevealResult; complete: () => void | Promise<void>; endedGame?: boolean }) {
  const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  const [settled, setSettled] = useState(reduced);
  const [faceUp, setFaceUp] = useState(reduced ? result.cards.length : 0);
  const [collecting, setCollecting] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  const favorable = result.loser !== 0;
  const verdict = result.lied ? '抓到吹牛了！' : '竟然全是真的。';
  const verdictAt = LEAD_IN + (result.cards.length - 1) * CARD_GAP + FLIP_TIME + 180;

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(media?.matches ?? false);
    media?.addEventListener?.('change', change);
    return () => media?.removeEventListener?.('change', change);
  }, []);
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const element = dialog.current;
    if (typeof element?.showModal === 'function') element.showModal();
    else element?.setAttribute('open', '');
    return () => {
      element?.close?.();
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (settled || reduced) {
      setSettled(true);
      setFaceUp(result.cards.length);
      return;
    }
    // Accessible names are unveiled with the visual faces, never ahead of them.
    const timers = result.cards.map((_, index) => setTimeout(() => setFaceUp(index + 1), LEAD_IN + index * CARD_GAP + FLIP_TIME * .66));
    timers.push(setTimeout(() => setSettled(true), verdictAt));
    return () => timers.forEach(clearTimeout);
  }, [reduced, settled, result.cards.length, verdictAt]);
  useEffect(() => { if (settled) continueButton.current?.focus(); }, [settled]);
  useEffect(() => {
    if (!collecting) return;
    let active = true;
    const timer = setTimeout(() => {
      Promise.resolve().then(complete).catch((failure) => {
        if (active) { setError(failure instanceof Error ? failure.message : '确认失败，请重试。'); setCollecting(false); }
      });
    }, reduced ? 0 : 460 + (result.cards.length - 1) * 65);
    return () => { active = false; clearTimeout(timer); };
  }, [collecting, complete, reduced, result.cards.length]);

  return <dialog ref={dialog} className={'bluff-showdown' + (settled ? ' is-settled' : '') + (collecting ? ' is-collecting' : '') + (reduced ? ' reduced-motion' : '')}
    style={{ '--collect-y': result.loser === 0 ? '230px' : '-230px' } as CSSProperties}
    data-outcome={settled ? favorable ? 'win' : 'lose' : 'pending'} aria-label="质疑揭晓" aria-describedby="showdown-announcement"
    onCancel={(event) => { event.preventDefault(); setSettled(true); setError(''); setCollecting(true); }}>
    <div className="showdown-atmosphere" aria-hidden="true"><span /><span /><span /></div>
    <div className="showdown-content">
      <div className="showdown-topline"><span>THE MOMENT OF TRUTH</span><span>翻牌见真章</span></div>
      <div className="showdown-heading"><span className="showdown-challenger">{result.challenger === 0 ? '你向鲸鱼娘发起了质疑' : '鲸鱼娘向你发起了质疑'}</span>
        <h2>{settled ? verdict : '你吹牛！'}</h2>
        <p>{name(result.claimant)}刚才说，这是 <strong>{result.cards.length} 张 {result.rank}</strong><span className="showdown-suspense">。现在，翻开看看。</span></p>
      </div>
      <div className="showdown-cards" style={{ '--reveal-count': result.cards.length } as CSSProperties}>
        {result.cards.map((card, index) => {
          const mismatch = card.rank !== result.rank;
          const visible = settled || index < faceUp;
          return <div key={card.id} className={'showdown-card-slot' + (settled ? mismatch ? ' is-lie' : ' is-true' : '')}
            style={{ '--flip-delay': LEAD_IN + index * CARD_GAP + 'ms', '--card-tilt': (index - (result.cards.length - 1) / 2) * 5 + 'deg', '--entry-delay': index * 65 + 'ms' } as CSSProperties}>
            <div className="showdown-card-float"><div className="showdown-card-flipper">
              <div className="showdown-card-face showdown-card-back" aria-hidden={visible}><PlayingCard hidden hiddenLabel={'第 ' + (index + 1) + ' 张盖牌'} /><span className="showdown-back-emblem" aria-hidden="true">?</span></div>
              <div className="showdown-card-face showdown-card-front" aria-hidden={!visible}><PlayingCard card={card} /></div>
            </div></div>
            <span className="showdown-card-verdict" aria-hidden={!settled}>{settled ? mismatch ? '露馅了' : '对得上' : '\u00a0'}</span>
          </div>;
        })}
      </div>
      <div className="showdown-resolution" role="status" id="showdown-announcement">
        {settled ? <><span className="showdown-seal" aria-hidden="true">{result.lied ? '破绽' : '属实'}</span><div><strong>{name(result.challenger)}{result.lied ? '质疑成功' : '质疑失败'}</strong><p>{result.lied ? name(result.claimant) + '的牌里有假牌。' : '每一张都符合声称。'}<br /><span>{name(result.loser)}收走桌面全部 <b>{result.collected}</b> 张牌</span><br /><span>{endedGame || result.nextSeat === null ? '最后一手已通过验证，本局结束。' : '质疑结算后，由' + name(result.nextSeat ?? result.challenger) + '出下一手。'}</span></p></div></>
          : <div className="showdown-waiting"><span /><span /><span /><p>别急，答案就在牌背后。</p></div>}
      </div>
      <div className="showdown-footer">{error && <p role="alert">{error}</p>}{settled ? <button ref={continueButton} className="showdown-continue" disabled={collecting} onClick={() => { setError(''); setCollecting(true); }}>{collecting ? '正在收牌…' : endedGame || result.nextSeat === null ? '查看本局结果' : '继续对局'} <span aria-hidden="true">↗</span></button>
        : <button className="showdown-skip" onClick={() => setSettled(true)}>直接看结果 <span aria-hidden="true">→</span></button>}
        <span>只翻开刚才那一手 · 整个牌堆由输家收走</span>
      </div>
    </div>
  </dialog>;
}
