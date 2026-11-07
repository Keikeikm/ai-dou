import { useCallback, useEffect, useRef, useState } from 'react';
import type { BlackjackRoomView } from '../../shared/blackjack.js';
import { closeBlackjackRoom, consumeBlackjackOpeningReveal, controlBlackjackRoom, createBlackjackRoom, readBlackjackRoom } from '../api/blackjack.js';
import { providerConfiguration } from '../api/client.js';
import { PlayingCard } from './Cards.js';
import { RoomDrawer } from './RoomDrawer.js';
import '../styles/blackjack.css';

const reasons: Record<string, string> = {
  'player-blackjack': '你起手就是 A 加一张 10 点牌，天生 21 点！',
  'opponent-blackjack': '鲸鱼娘起手就是天生 21 点。',
  'both-blackjack': '两个人都是天生 21 点，这局握手言和。',
  'player-bust': '你的点数超过 21，爆牌了。',
  'opponent-bust': '鲸鱼娘的点数超过 21，爆牌了。',
  'higher-total': '双方已经停牌，点数更接近 21 的一方获胜。',
  'equal-total': '双方已经停牌，点数相同，这局平手。',
};
function Rules() {
  return <div className="bluff-rules"><p>你和鲸鱼娘自由对战。再拿一张，还是见好就收？</p><ol>
    <li><strong>每人先拿两张。</strong>每局新洗一副 52 张牌，去掉大小王。双方只公开第一张牌，其余牌在结算时揭晓。</li>
    <li><strong>尽量接近 21 点。</strong>2–10 按牌面算，J、Q、K 算 10，A 自动按 1 或 11 计算，取不爆牌的最大点数。</li>
    <li><strong>你先行动，轮流要牌或停牌。</strong>要牌拿一张；停牌后不能再拿牌，对方可以继续。达到 21 点自动停牌，先超过 21 点的一方立即输掉本局。</li>
    <li><strong>两个人都停牌，再比大小。</strong>点数高的一方赢，同点平局。起手两张就是 21 点为「天生 21 点」，直接结算；双方都有则平局。</li>
  </ol><p className="bluff-note">鲸鱼娘由 DeepSeek 决定要牌或停牌，只能看见你的明牌、手牌张数和公开行动。本桌不下注，也没有分牌、加倍和保险。</p></div>;
}
function Setup({ navigate }: { navigate: (path: string) => void }) {
  const [key, setKey] = useState('');
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void providerConfiguration(controller.signal).then((config) => setConfigured(config.hasServerKey)).catch(() => { if (!controller.signal.aborted) setConfigured(false); });
    return () => controller.abort();
  }, []);
  async function start() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { const grant = await createBlackjackRoom(key.trim()); setKey(''); navigate('/blackjack/' + grant.room.id); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '开局失败，请重试。'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <main className="bluff-setup bj-setup" aria-label="21点开局"><section className="bluff-invitation">
    <span className="game-kicker">TWENTY ONE · 自由对战</span><h1>再一张？<br />心跳刚刚好。</h1><p>与 DeepSeek 鲸鱼娘面对面。<br />离 21 点越近，越要相信你的判断。</p>
    <img src="/avatars/azure.png" alt="鲸鱼娘 Q版角色" /><span className="whale-sticker">「这一次，你敢比我多拿一张吗？」</span>
  </section><section className="bluff-setup-panel"><span className="game-kicker">一张牌，改变胜负。</span><h2>你 VS 鲸鱼娘</h2>
    <form onSubmit={(event) => { event.preventDefault(); void start(); }}><label htmlFor="bj-api-key">DeepSeek API key {configured && <small>服务端已配置</small>}</label>
      <input id="bj-api-key" type="password" autoComplete="off" maxLength={2048} value={key} disabled={busy} onChange={(event) => setKey(event.target.value)} placeholder={configured ? '留空即可使用已有密钥' : '输入你的 DeepSeek API key'} />
      <p className="bluff-note">密钥仅保存在服务端内存；对战会调用 DeepSeek API 并消耗额度。</p>
      <button className="primary bluff-start" disabled={busy || (!key.trim() && !configured)}>{busy ? '正在洗牌…' : '和鲸鱼娘玩 21 点'} <span aria-hidden="true">↗</span></button>
      {error && <p role="alert">{error}</p>}
    </form><details className="bluff-howto" open><summary>一分钟学会 21 点</summary><Rules /></details>
  </section></main>;
}

type Reveal = { key: string; count: number; history: BlackjackRoomView['history'] };
function Match({ id }: { id: string }) {
  const [room, setRoom] = useState<BlackjackRoomView | null>(null);
  const latest = useRef<BlackjackRoomView | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState('');
  const [replacementKey, setReplacementKey] = useState('');
  const [refresh, setRefresh] = useState(0);
  const resultButton = useRef<HTMLButtonElement>(null);
  const update = useCallback((value: BlackjackRoomView) => {
    const previous = latest.current;
    if (previous && (previous.generation > value.generation || previous.generation === value.generation && previous.revision > value.revision)) return;
    const opening = !previous && consumeBlackjackOpeningReveal(value);
    const shouldReveal = value.phase === 'finished' && (opening || previous && (previous.phase !== 'finished' || previous.generation !== value.generation));
    latest.current = value;
    if (previous?.generation !== value.generation) setReveal(null);
    if (shouldReveal && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) setReveal({ key: value.generation + ':' + value.revision, count: 0, history: previous?.generation === value.generation ? previous.history : [] });
    setRoom(value);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const value = await readBlackjackRoom(id, controller.signal); if (!controller.signal.aborted && !pending.current) { update(value); setError(''); } }
      catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '连接中断，请重试。'); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1000); }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, refresh, update]);
  const revealKey = reveal?.key;
  useEffect(() => {
    if (!revealKey) return;
    const count = latest.current!.opponent.length - 1;
    const timers = Array.from({ length: count }, (_, index) => setTimeout(() => setReveal((current) => current?.key === revealKey ? { ...current, count: index + 1 } : current), 520 + index * 740));
    timers.push(setTimeout(() => setReveal(null), 520 + count * 740));
    return () => timers.forEach(clearTimeout);
  }, [revealKey]);
  useEffect(() => { if (room?.phase === 'finished' && !reveal) resultButton.current?.focus(); }, [room?.phase, revealKey]);
  async function control(input: Record<string, unknown>) {
    if (!latest.current || pending.current || reveal) return;
    pending.current = true; setBusy(true); setError('');
    try { update(await controlBlackjackRoom(latest.current, input)); setReplacementKey(''); }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作失败，请重试。');
      // Reconcile a lost response before accepting another decision.
      try { update(await readBlackjackRoom(id)); } catch { /* Keep the explicit recovery control available. */ }
    } finally { pending.current = false; setBusy(false); }
  }
  if (!room) return <main className="bluff-loading"><p role={error ? 'alert' : 'status'}>{error || '正在回到牌桌…'}</p><button onClick={() => setRefresh((value) => value + 1)}>重新连接</button><a href="/blackjack">重新开局</a></main>;
  const finished = room.phase === 'finished' && !reveal;
  const canAct = room.phase === 'play' && room.turn === 0 && !room.thinking && !busy && !reveal && !room.stood[0];
  const title = room.result === 'win' ? '这局，是你赢了！' : room.result === 'push' ? '不分伯仲。' : '鲸鱼娘赢了这一局';
  const opponentState = reveal ? '底牌，正在揭晓…' : finished ? room.opponentValue?.bust ? '爆牌' : room.opponentValue?.blackjack ? '天生 21 点' : '最终点数' : room.stood[1] ? '已停牌 · 点数保密' : '第一张明牌 · 其余保密';
  const status = reveal ? '翻牌见分晓' : finished ? title : room.error ? '对局已暂停，等待重试' : room.thinking ? '鲸鱼娘正在决定，要牌还是停牌…' : room.stood[0] ? '你已停牌，等待鲸鱼娘完成行动。' : '轮到你了。再拿一张，还是见好就收？';
  const history = reveal?.history ?? room.history;
  return <main className="bj-match" aria-label="21点牌桌"><div className="bj-heading"><span>你 VS 鲸鱼娘 <small>DeepSeek · 自由对战</small></span><span>第 {room.generation} 局</span></div>
    <div className="bj-layout"><section className={'bj-table' + (reveal ? ' bj-revealing' : '')} aria-label="对战牌桌">
      <div className="bj-table-mark" aria-hidden="true">21</div>
      <div className="bj-whale"><img src="/avatars/azure.png" alt="鲸鱼娘 Q版角色" /><div><span className="bj-seat-label">YOUR RIVAL</span><h2>鲸鱼娘</h2><p>{reveal ? '「最后的答案，藏在牌背后。」' : finished ? room.result === 'win' ? '「被你赢啦，再来一局！」' : room.result === 'push' ? '「默契得有点过分了哦。」' : '「嘿嘿，这次是我赢了。」' : '「再多一张，也许就不一样了。」'}</p></div></div>
      <section className="bj-opponent" aria-label="鲸鱼娘的牌"><div className="bj-hand-label"><span>{opponentState}</span><b aria-label="鲸鱼娘点数">{finished ? room.opponentValue?.total : '?'}</b></div>
        <div className="bj-cards">{room.opponent.map((card, index) => {
          const flipped = Boolean(card && (!reveal || index <= reveal.count));
          return index === 0 ? <PlayingCard key="upcard" card={card ?? undefined} hidden={!card} /> : <div key={index} className={'bj-flip' + (flipped ? ' is-revealed' : '')}>
            <div className="bj-flip-inner"><div className="bj-flip-back" aria-hidden={flipped}><PlayingCard hidden hiddenLabel={'鲸鱼娘第 ' + (index + 1) + ' 张暗牌'} /></div><div className="bj-flip-front" aria-hidden={!flipped}>{flipped && card && <PlayingCard card={card} />}</div></div>
          </div>;
        })}</div>
      </section>
      <div className="bj-divider"><span /> <i>TWENTY ONE</i> <span /></div>
      <section className="bj-player" aria-label="我的手牌"><div className="bj-hand-label"><span>你的手牌 <small>{room.handValue.blackjack ? '天生 21 点' : room.handValue.bust ? '爆牌' : room.stood[0] ? '已停牌' : room.handValue.soft ? 'A 当前按 11 点计算' : 'A 可自动按 1 / 11 点计算'}</small></span><b className={room.handValue.bust ? 'bj-bust' : ''} aria-label="我的点数">{room.handValue.total}</b></div>
        <div className="bj-cards">{room.hand.map((card) => <div className="bj-drawn-card" key={card.id}><PlayingCard card={card} /></div>)}</div>
      </section>
      <div className="bj-status" role="status">{(room.thinking || reveal) && <span className="thinking-dot" />}{status}</div>
      {reveal ? <div className="bj-reveal-controls"><span>THE MOMENT OF TRUTH</span><button className="quiet" onClick={() => setReveal(null)}>直接看结果 ↗</button></div>
        : finished ? <div className={'bj-result bj-result-' + room.result} aria-label="本局结果"><span className="bj-result-seal" aria-hidden="true">{room.result === 'win' ? '✦' : room.result === 'push' ? '=' : '♠'}</span><div><h2>{title}</h2><p>{reasons[room.reason ?? ''] ?? '本局已结束。'}</p><span className="bj-scoreline">你 {room.handValue.total} <i>:</i> 鲸鱼娘 {room.opponentValue?.total}</span></div><button ref={resultButton} className="primary" disabled={busy} onClick={() => void control({ type: 'restart' })}>{busy ? '正在洗牌…' : '再来一局 ↗'}</button></div>
          : <div className="bj-actions"><button className="primary" disabled={!canAct} onClick={() => void control({ action: { type: 'hit' } })}><span>＋</span> 要牌 <small>再拿一张</small></button><button disabled={!canAct} onClick={() => void control({ action: { type: 'stand' } })}><span>✓</span> 停牌 <small>就到这里</small></button></div>}
      {room.error && <div className="bj-error" role="alert"><p>{room.error}</p><label htmlFor="bj-replacement-key">更换密钥（可选）</label><input id="bj-replacement-key" type="password" autoComplete="off" maxLength={2048} value={replacementKey} disabled={busy} onChange={(event) => setReplacementKey(event.target.value)} placeholder="留空使用当前密钥" /><button disabled={busy || Boolean(reveal)} onClick={() => void control({ type: 'retry', ...(replacementKey.trim() ? { apiKey: replacementKey.trim() } : {}) })}>重试鲸鱼娘的动作</button></div>}
      {error && <div className="bj-error" role="alert"><p>{error}</p><button disabled={busy} onClick={() => setRefresh((value) => value + 1)}>重新连接</button></div>}
    </section><aside className="bj-journal" aria-label="公开牌局记录"><span className="game-kicker">TABLE NOTES</span><h2>牌桌手记</h2><p>每一次犹豫，都是选择。</p><ol><li><span>00</span>已发牌。你先行动。</li>{history.map((event) => <li key={event.sequence}><span>{String(event.sequence).padStart(2, '0')}</span>{event.seat === 0 ? '你' : '鲸鱼娘'}{event.type === 'hit' ? '要了一张牌' : '选择停牌'}</li>)}</ol><div className="bj-journal-note"><b>离 21 点近一点。</b><p>超过就爆牌，停下就不能再拿。鲸鱼娘也一样。</p><span>本局记录会保存到数据中心。</span></div></aside></div>
  </main>;
}
export function BlackjackGame({ id, navigate }: { id?: string; navigate: (path: string) => void }) {
  const [rules, setRules] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState('');
  async function leave() {
    if (!id) { navigate('/'); return; }
    if (pending.current) return;
    pending.current = true; setLeaving(true);
    try { await closeBlackjackRoom(id); navigate('/'); }
    catch { setError('关闭房间失败，请重试；也可直接返回大厅，闲置房间会自动过期。'); }
    finally { pending.current = false; setLeaving(false); }
  }
  return <div className="bluff-shell bj-shell"><header className="club-header"><a className="brand" href="/" onClick={(event) => { event.preventDefault(); void leave(); }}><span className="brand-icon">♠</span><span>AI DOU <small>鲸鱼娘的棋牌室</small></span></a><span className="club-breadcrumb">棋牌室 <span>/</span> 21 点</span><div><button className="quiet" onClick={() => setRules(true)}>玩法说明</button><button className="quiet" disabled={leaving} onClick={() => void leave()}>返回大厅 ↗</button></div></header>
    {error && <p className="bj-leave-error" role="alert">{error} <a href="/">返回大厅</a></p>}
    {id ? <Match key={id} id={id} /> : <Setup navigate={navigate} />}
    {rules && <RoomDrawer title="21 点 · 玩法说明" close={() => setRules(false)}><Rules /></RoomDrawer>}
  </div>;
}
