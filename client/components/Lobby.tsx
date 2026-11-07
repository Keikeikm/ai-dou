import { profiles } from '../domain/presentation.js';
import { RoomCreation } from './RoomTools.js';
import { currentProfile } from '../api/player-profile.js';

export function Lobby({ navigate }: { navigate: (path: string) => void }) {
  return <main className="game-lobby" aria-label="游戏大厅">
    <section className="club-welcome"><div><span className="game-kicker">WELCOME TO THE CLUB</span><h1>今天，玩点什么？</h1><p>鲸鱼娘已经就位。选一张牌桌，来场有趣的较量。</p><div className="club-note"><span>♣</span> 有牌搭子，才有好时光。</div></div>
      <div className="club-host"><span>「等你好久啦！」</span><img src="/avatars/azure.png" alt="鲸鱼娘 Q版角色" /></div></section>
    <div className="club-section-heading"><h2>选一张牌桌</h2><span>03 GAMES · 随时入座</span></div>
    <div className="club-games"><section className="club-game club-doudizhu" aria-labelledby="doudizhu-title"><div className="club-game-top"><span>01 / 经典牌局</span><span>3 人 · 团队策略</span></div>
      <div className="club-card-art" aria-hidden="true"><span>♠<b>A</b></span><span>♥<b>A</b></span><span>♣<b>A</b></span></div>
      <div className="club-game-content"><h3 id="doudizhu-title">斗地主</h3><p>叫地主、打配合，和熟悉的 AI 牌友过过招。</p><div className="club-mini-cast">{profiles.map((profile) => <img src={profile.avatar} alt={profile.name} key={profile.name} />)}<span>老朋友，都在这里</span></div><RoomCreation navigate={navigate} /></div>
    </section><section className="club-game club-bluff" aria-labelledby="bluff-title"><div className="club-game-top"><span>02 / 新牌桌 <b>NEW</b></span><span>2 人 · 心理博弈</span></div>
      <div className="club-card-art bluff-art" aria-hidden="true"><span>♢<b>?</b></span><span>♢<b>?</b></span><i>真的，还是假的？</i></div>
      <div className="club-game-content"><h3 id="bluff-title">吹牛 <small>我才不信呢。</small></h3><p>盖下你的牌，藏好你的心思。看穿鲸鱼娘的谎话。</p><div className="club-mini-cast"><img src="/avatars/azure.png" alt="DeepSeek 鲸鱼娘" /><span>你和鲸鱼娘，一对一较量</span></div><button className="primary club-enter" onClick={() => navigate('/bluff')}>和鲸鱼娘吹牛 <span aria-hidden="true">↗</span></button></div>
    </section><section className="club-game club-blackjack" aria-labelledby="blackjack-title"><div className="club-game-top"><span>03 / 新牌桌 <b>NEW</b></span><span>2 人 · 要牌还是停牌</span></div>
      <div className="club-card-art blackjack-art" aria-hidden="true"><span>♠<b>A</b></span><span>♥<b>K</b></span><i>刚刚好，21。</i></div>
      <div className="club-game-content"><h3 id="blackjack-title">21 点 <small>再来一张？</small></h3><p>靠近 21，别越过界。轮到鲸鱼娘亮出她的底牌。</p><div className="club-mini-cast"><img src="/avatars/azure.png" alt="DeepSeek 鲸鱼娘" /><span>自由对战 · 你与鲸鱼娘轮流决策</span></div><button className="primary club-enter" onClick={() => navigate('/blackjack')}>和鲸鱼娘玩 21 点 <span aria-hidden="true">↗</span></button></div>
    </section></div>
    <a className="club-data-entry" href="/analytics" onClick={(event) => { event.preventDefault(); navigate('/analytics'); }}>
      <span className="club-data-icon" aria-hidden="true">▂ ▅ ▃ ▇</span><div><span className="game-kicker">YOUR PLAY, OVER TIME · AVA</span><h2>打过的牌，都算数。</h2><p>去数据中心，看看多局走势、打法习惯，或者回看一场较量。</p><small>当前开局身份：{currentProfile().name} · 在数据中心管理玩家档案</small></div><span className="club-data-arrow" aria-hidden="true">↗</span>
    </a><footer className="club-footer"><span>AI DOU · 小小棋牌室，慢慢添新桌。</span><span aria-hidden="true">♠ ♥ ♣ ♦</span></footer>
  </main>;
}
