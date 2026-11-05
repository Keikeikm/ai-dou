import { useCallback, useEffect, useRef, useState } from 'react';
import { BLUFF_RANKS, BLUFF_RULES_VERSION, type BluffAction, type BluffEvent } from '../../shared/bluff.js';
import { closeBluffRoom, controlBluffRoom, createBluffRoom, readBluffRoom } from '../api/bluff.js';
import { providerConfiguration } from '../api/client.js';
import { PlayingCard } from './Cards.js';
import { RoomDrawer } from './RoomDrawer.js';
import { BluffReveal } from './BluffReveal.js';
import { useBluffPresentation } from '../hooks/useBluffPresentation.js';

const playerName = (seat: number) => seat === 0 ? '你' : '鲸鱼娘';

function Rules() {
  return <div className="bluff-rules"><p>一副扑克，两个人。一半靠记牌，一半靠演技。</p><ol>
    <li><strong>各拿 26 张牌。</strong>去掉大小王，你先出牌。目标是最先出完手牌。</li>
    <li><strong>按点数轮流声称。</strong>从 A 开始，按 A → 2 → … → K → A 循环。每次选 1–4 张任意手牌盖下，声称它们都是当前点数；可以全真、全假，也可以混牌。</li>
    <li><strong>相信，或喊「你吹牛」。</strong>相信后不翻牌；质疑时只翻开刚出的那一手。有一张不符就算撒谎，出牌者收走整个牌堆；全对则质疑者收走整个牌堆。</li>
    <li><strong>赢下质疑的人，接着出牌。</strong>抓到假牌：说谎者收牌，质疑者出下一手；质疑失败：质疑者收牌，说真话的人继续出牌。选择相信则由回应者出牌。每手点数照常前进，最后一手验证通过则直接结束。</li>
    <li><strong>最后一手也要过关。</strong>对方相信，或质疑后证实你说真话，才算获胜。</li>
  </ol><p className="bluff-note">鲸鱼娘只知道自己的牌、你的剩余张数和公开记录。未被质疑的盖牌始终保密。</p></div>;
}

function eventText(event: BluffEvent) {
  if (event.claim) return playerName(event.seat) + ' 声称出了 ' + event.claim.count + ' 张 ' + event.claim.rank;
  if (event.reveal) return playerName(event.seat) + ' 质疑，' + (event.reveal.lied ? '抓到吹牛！' : '对方说了真话。') + playerName(event.reveal.loser) + ' 收走 ' + event.reveal.collected + ' 张';
  return playerName(event.seat) + ' 选择相信';
}

function Setup({ navigate }: { navigate: (path: string) => void }) {
  const [apiKey, setApiKey] = useState('');
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void providerConfiguration(controller.signal).then((config) => setConfigured(config.hasServerKey)).catch(() => { if (!controller.signal.aborted) setConfigured(false); });
    return () => controller.abort();
  }, []);
  async function start() {
    if (busy) return;
    setBusy(true); setError('');
    try { const { room } = await createBluffRoom(apiKey.trim()); setApiKey(''); navigate('/bluff/' + room.id); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '开局失败，请重试。'); }
    finally { setBusy(false); }
  }
  return <main className="bluff-setup" aria-label="吹牛开局"><section className="bluff-invitation">
    <span className="game-kicker">THE BLUFF CLUB · 双人牌局</span><h1>敢不敢<br />信我一次？</h1><p>与 DeepSeek 鲸鱼娘面对面。<br />藏好你的牌，也藏好你的小心思。</p>
    <img src="/avatars/azure.png" alt="鲸鱼娘 Q版角色" /><span className="whale-sticker">「我这么可爱，怎么会骗你呢？」</span>
  </section><section className="bluff-setup-panel"><span className="game-kicker">坐下，发牌。</span><h2>你 VS 鲸鱼娘</h2>
    <form onSubmit={(event) => { event.preventDefault(); void start(); }}>
      <label htmlFor="bluff-api-key">DeepSeek API key {configured && <small>服务端已配置</small>}</label>
      <input id="bluff-api-key" type="password" autoComplete="off" maxLength={2048} value={apiKey} disabled={busy} onChange={(event) => setApiKey(event.target.value)} placeholder={configured ? '留空即可使用已有密钥' : '输入你的 DeepSeek API key'} />
      <p className="bluff-note">密钥仅保存在服务端内存；对战会调用 DeepSeek API 并消耗额度。{configured === false && '也可以在 .env 中配置 DEEPSEEK_API_KEY。'}</p>
      <button className="primary bluff-start" disabled={busy || (!apiKey.trim() && !configured)}>{busy ? '正在洗牌…' : '开始和鲸鱼娘吹牛'} <span aria-hidden="true">↗</span></button>
      {error && <p role="alert">{error}</p>}
    </form><details className="bluff-howto" open><summary>一分钟学会吹牛</summary><Rules /></details>
  </section></main>;
}

function Match({ id }: { id: string }) {
  const { room, reveal: presentation, revealing, update, finishReveal, replayReveal, latestRoom } = useBluffPresentation();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [replacementKey, setReplacementKey] = useState('');
  const [refresh, setRefresh] = useState(0);
  const pending = useRef(false);
  const completeReveal = useCallback(async () => {
    if (pending.current) return;
    const current = latestRoom();
    if (!current) return;
    pending.current = true; setBusy(true);
    try {
      if (current.revealPending != null) update(await controlBluffRoom(current, { type: 'ack-reveal', revealRevision: current.revealPending }));
      finishReveal();
    } catch (failure) {
      // A reply can be lost after the server accepted it. Reconcile before a
      // retry so confirming the same reveal cannot trigger a second AI turn.
      try { update(await readBluffRoom(current.id)); } catch { /* Keep the pending reveal retryable. */ }
      throw failure;
    } finally { pending.current = false; setBusy(false); }
  }, [latestRoom, update, finishReveal]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const value = await readBluffRoom(id, controller.signal); if (!controller.signal.aborted && !pending.current) { update(value); setError(''); } }
      catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '连接中断，请重试。'); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1000); }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, refresh, update]);
  useEffect(() => { setSelected(new Set()); }, [room?.revision, room?.generation]);
  async function control(input: Record<string, unknown>) {
    if (!room || pending.current || revealing.current) return;
    pending.current = true; setBusy(true); setError('');
    try { update(await controlBluffRoom(room, input)); setReplacementKey(''); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败'); setRefresh((value) => value + 1); }
    finally { pending.current = false; setBusy(false); }
  }
  const act = (action: BluffAction) => void control({ action });
  if (!room) return <main className="bluff-loading"><p role={error ? 'alert' : 'status'}>{error || '正在回到牌桌…'}</p><button onClick={() => setRefresh((value) => value + 1)}>重新连接</button><a href="/bluff">重新开局</a></main>;
  const myTurn = room.turn === 0 && room.phase !== 'finished' && !busy && !room.thinking && !presentation && room.revealPending == null;
  const reveal = room.lastReveal;
  const sorted = [...room.hand].sort((a, b) => BLUFF_RANKS.indexOf(a.rank as typeof BLUFF_RANKS[number]) - BLUFF_RANKS.indexOf(b.rank as typeof BLUFF_RANKS[number]));
  const status = room.phase === 'finished' ? room.winner === 0 ? '这局，是你赢了！' : '鲸鱼娘赢了这一局'
    : room.revealPending != null ? '翻牌已结算，确认后进入下一手。' : room.error ? '鲸鱼娘暂时离开了思考频道' : room.thinking || room.turn === 1 ? '鲸鱼娘正在思考…'
      : room.phase === 'respond' ? '轮到你回应鲸鱼娘：相信，还是质疑？' : '轮到你出牌，藏好你的表情。';
  return <main className="bluff-match" aria-label="双人吹牛牌桌">
    {room.rulesVersion !== BLUFF_RULES_VERSION && <p className="bluff-action-error" role="alert">当前房间仍使用旧版出牌顺序。请重启服务后重新开局，启用“质疑赢家出下一手”。</p>}
    <div className="bluff-match-heading"><span>你 VS 鲸鱼娘 <span className="bluff-live">DeepSeek</span></span><span>第 {room.generation} 局 · {room.model}</span></div>
    <div className="bluff-match-grid"><section className="bluff-felt">
      <div className="bluff-opponent"><img src="/avatars/azure.png" alt="鲸鱼娘 Q版角色" /><div><strong>鲸鱼娘</strong><span>手牌 <b>{room.opponentCount}</b> 张</span><p>{room.phase === 'finished' ? room.winner === 0 ? '「被你看穿啦，再来一次！」' : '「嘿嘿，这次是我赢了。」' : room.thinking ? '「让我想想，你在打什么主意…」' : '「真真假假，你猜得到吗？」'}</p></div></div>
      <div className="bluff-center"><div className="bluff-pile" aria-label={'桌面 ' + room.pileCount + ' 张盖牌'}>{room.pileCount > 0 ? <><PlayingCard hidden hiddenLabel="桌面盖牌" /><PlayingCard hidden hiddenLabel="桌面盖牌" /></> : <span className="bluff-empty-pile">♠</span>}<span>{room.pileCount} 张在桌面</span></div>
        <div className="bluff-claim"><span>{room.claim ? playerName(room.claim.seat) + ' 声称' : '本轮声称点数'}</span><strong>{room.claim && <small>{room.claim.count} 张 </small>}{room.claim?.rank ?? room.rank}</strong><span>{room.claim ? '盖下的牌，只有出牌的人知道' : '你可以出真牌，也可以大胆吹牛'}</span></div>
      </div>
      <div className="bluff-status" role="status"><span className={room.thinking ? 'thinking-dot' : ''} />{status}</div>
      {room.revealPending != null && !presentation && <div className="bluff-result"><p>{room.lastReveal?.nextSeat === null ? '最后一手已通过验证，本局结束。' : playerName(room.lastReveal?.nextSeat ?? room.turn) + '出下一手。'}</p><button className="primary" disabled={busy} onClick={() => { void completeReveal().catch((failure) => setError(failure instanceof Error ? failure.message : '确认失败，请重试。')); }}>{busy ? '正在确认…' : '确认翻牌，继续对局'}</button></div>}
      {room.phase === 'finished' && <div className="bluff-result"><strong>{room.winner === 0 ? '✦ 好牌技，更有好演技。' : '差一点点，下次看穿她。'}</strong><p>{room.winner === 0 ? '你的最后一手成功过关。' : '她的最后一手成功过关。'}</p><button className="primary" disabled={busy} onClick={() => void control({ type: 'restart' })}>再来一局</button><a href="/">返回大厅</a></div>}
      {room.error && <div className="bluff-recovery" role="alert"><p>{room.error}</p><label htmlFor="bluff-replacement-key">更换密钥（可选）</label><input id="bluff-replacement-key" type="password" autoComplete="off" maxLength={2048} value={replacementKey} onChange={(event) => setReplacementKey(event.target.value)} placeholder="留空使用当前密钥" /><button disabled={busy} onClick={() => void control({ type: 'retry', ...(replacementKey.trim() ? { apiKey: replacementKey.trim() } : {}) })}>重试鲸鱼娘的动作</button></div>}
      {error && <p className="bluff-action-error" role="alert">{error}</p>}
    </section><aside className="bluff-journal" aria-label="公开牌局记录"><div className="bluff-journal-title"><strong>牌桌手记</strong><span>只记录公开信息</span></div>
      {reveal && <div className="bluff-reveal"><small>最近一次翻牌 · 声称 {reveal.rank}</small><strong>{reveal.lied ? '抓到吹牛了！' : '这次说的是真话'}</strong><div className="bluff-revealed-cards">{reveal.cards.map((card) => <PlayingCard key={card.id} card={card} />)}</div><p>{playerName(reveal.loser)}收走了 {reveal.collected} 张牌</p><button className="quiet bluff-replay-reveal" disabled={busy || room.thinking || room.turn !== 0 && room.phase !== 'finished'} onClick={replayReveal}>重看翻牌 ↗</button></div>}
      <ol className="bluff-events">{room.history.length === 0 ? <li>牌已发好。由你先声称 A。</li> : [...room.history].reverse().map((event) => <li key={event.sequence}><span>{String(event.sequence).padStart(2, '0')}</span>{eventText(event)}</li>)}</ol>
    </aside></div>
    <section className="bluff-hand" aria-label="我的手牌"><div className="bluff-hand-heading"><div><strong>我的手牌</strong><span>{room.hand.length} 张 · 已选 {selected.size}/4</span></div>
      {myTurn && room.phase === 'play' && <button className="quiet" onClick={() => setSelected(new Set())} disabled={!selected.size}>清空选择</button>}
      <span>{room.phase === 'finished' ? '本局结束' : room.phase === 'play' ? room.turn === 0 ? '轮到你出牌：点选 1–4 张牌' : '等待鲸鱼娘出牌' : room.turn === 0 ? '轮到你回应：相信或质疑，不是出牌' : '等待鲸鱼娘回应你的出牌'}</span></div>
      <div className="bluff-hand-cards">{sorted.map((card) => <PlayingCard key={card.id} card={card} selection={{ selected, enabled: myTurn && room.phase === 'play', toggle: (id) => setSelected((previous) => { const next = new Set(previous); if (next.has(id)) next.delete(id); else if (next.size < 4) next.add(id); return next; }) }} />)}</div>
      <div className="bluff-actions">{room.phase === 'respond' && room.turn === 0 ? <><p>鲸鱼娘说：这是 <strong>{room.claim?.count} 张 {room.claim?.rank}</strong>。你信吗？</p><button disabled={!myTurn} onClick={() => act({ type: 'accept' })}>相信她</button><button className="primary bluff-challenge" disabled={!myTurn} onClick={() => act({ type: 'challenge' })}>你吹牛！翻牌</button></>
        : room.phase !== 'finished' && <><p>{room.turn === 0 ? <>无论选什么牌，都将声称是 <strong>{room.rank}</strong></> : '把表情藏好，等鲸鱼娘出招。'}</p><button className="primary" disabled={!myTurn || !selected.size || room.phase !== 'play'} onClick={() => act({ type: 'play', cards: [...selected] })}>{busy ? '正在出牌…' : selected.size ? '盖牌，声称 ' + selected.size + ' 张 ' + room.rank : '选牌后盖下'}</button></>}</div>
    </section>
    {presentation && <BluffReveal key={presentation.key} result={presentation.result} endedGame={presentation.endedGame} complete={completeReveal} />}
  </main>;
}

export function BluffGame({ id, navigate }: { id?: string; navigate: (path: string) => void }) {
  const [rules, setRules] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState('');
  async function leave() {
    if (!id) { navigate('/'); return; }
    setLeaving(true);
    try { await closeBluffRoom(id); navigate('/'); } catch { setLeaveError('关闭房间失败，可直接返回大厅；闲置房间会自动过期。'); } finally { setLeaving(false); }
  }
  return <div className="bluff-shell"><header className="club-header"><a className="brand" href="/"><span className="brand-icon">♠</span><span>AI DOU <small>鲸鱼娘的棋牌室</small></span></a><span className="club-breadcrumb">棋牌室 <span>/</span> 吹牛</span><div><button className="quiet" onClick={() => setRules(true)}>玩法说明</button><button className="quiet" disabled={leaving} onClick={() => void leave()}>返回大厅 ↗</button></div></header>
    {leaveError && <p role="alert">{leaveError} <a href="/">返回大厅</a></p>}
    {id ? <Match key={id} id={id} /> : <Setup navigate={navigate} />}
    {rules && <RoomDrawer title="吹牛 · 玩法说明" close={() => setRules(false)}><Rules /></RoomDrawer>}
  </div>;
}
