import { useEffect, useMemo, useState } from 'react';
import { dataOverview, createProfile, exportUrl } from '../api/game-data.js';
import { currentProfile, selectProfile } from '../api/player-profile.js';
import { gameLabels, statusLabels, type DataFilter, type DataResponse, type GameKind, type PlayerAggregate } from '../../shared/game-data.js';
import { runAvaAnalysis, chartLabels, type AnalysisChartType } from '../domain/ava-analysis.js';
import type { AnalysisDataset } from '../domain/replay-analysis.js';
import { AnalysisChart } from './AnalysisChart.js';
import { DataEpisode } from './DataEpisode.js';
import '../styles/analytics.css';

const number = (value: number) => value.toLocaleString('zh-CN');
const percent = (a: number, b: number) => b ? (a / b * 100).toFixed(1) + '%' : '—';
export const dataDate = (at: number) => new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function rate(a: number, b: number) { return <><strong>{percent(a, b)}</strong><small>{a} / {b}</small></>; }

export default function AnalyticsPage() {
  const [game, setGame] = useState<GameKind>('bluff');
  const [profileId, setProfileId] = useState('');
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [status, setStatus] = useState<NonNullable<DataFilter['status']> | ''>('finished');
  const [offset, setOffset] = useState(0); const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<DataResponse | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(true);
  const [identity, setIdentity] = useState(currentProfile); const [name, setName] = useState(''); const [saving, setSaving] = useState(false); const [profileError, setProfileError] = useState('');
  const [episodeId, setEpisodeId] = useState<string | null>(null);
  const filter = useMemo<DataFilter>(() => ({ game, ...(profileId ? { profileId } : {}), ...(status ? { status } : {}),
    ...(from ? { from: Date.parse(from + 'T00:00:00+08:00') } : {}), ...(to ? { to: Date.parse(to + 'T23:59:59.999+08:00') } : {}) }), [game, profileId, status, from, to]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    dataOverview(filter, offset, controller.signal).then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch((e) => { if (!controller.signal.aborted) { setError(e.message); setData(null); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filter, offset, refresh]);
  const update = (change: () => void) => { change(); setOffset(0); setData(null); };
  const overview = data?.overview;
  const selected = overview?.players.find((player) => player.profileId === profileId);
  const players = new Map([...(data?.profiles ?? []).map((p) => [p.id, p.name] as const), ...(overview?.players ?? []).map((p) => [p.profileId, p.name] as const)]);
  async function addProfile(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setProfileError('');
    try { const profile = await createProfile(name); selectProfile(profile); setIdentity(profile); setName(''); setRefresh((r) => r + 1); }
    catch (e) { setProfileError((e as Error).message); } finally { setSaving(false); }
  }
  return <div className="data-shell"><header className="club-header"><a className="brand" href="/" aria-label="AI DOU 首页"><span className="brand-icon" aria-hidden="true">♠</span><span>AI DOU</span></a><nav className="data-nav"><a href="/">游戏大厅</a><span aria-current="page">数据中心</span></nav></header>
    <main className="data-main"><section className="data-hero"><div><span className="game-kicker">THE LONG GAME / 你的牌局档案</span><h1>每一手，<br />都有你的风格。</h1><p>把一局的输赢，放进更长的故事里。<br />让 AVA 从多局数据中，发现你的出牌习惯。</p><a href="#data-explore">开始探索 <span aria-hidden="true">↓</span></a></div>
      <div className="data-hero-aside"><img src="/avatars/azure.png" alt="鲸鱼娘" /><div><span>「这次，认真研究一下你。」</span><small>ANTV AVA · 多局分析</small></div></div></section>
    <section className="data-filter-panel" id="data-explore" aria-label="数据筛选"><div className="data-section-title"><h2>我的数据范围</h2><button className="quiet" onClick={() => setRefresh((r) => r + 1)} disabled={loading}>↻ 刷新数据</button></div>
      <div className="data-filters"><label>游戏<select value={game} onChange={(e) => update(() => { setGame(e.target.value as GameKind); setProfileId(''); })}><option value="bluff">吹牛</option><option value="doudizhu">斗地主</option></select></label>
        <label>分析玩家<select value={profileId} onChange={(e) => update(() => setProfileId(e.target.value))}><option value="">全部玩家</option>{[...players].map(([id, label]) => <option key={id} value={id}>{label}{id.startsWith('legacy_') ? ' · 旧档案' : ''} · {id === 'human_local' ? '默认' : id.slice(-6)}</option>)}{profileId && !players.has(profileId) && <option value={profileId}>已选玩家</option>}</select></label>
        <label>开始日期<input type="date" value={from} max={to || undefined} onChange={(e) => update(() => setFrom(e.target.value))} /></label><label>结束日期<input type="date" value={to} min={from || undefined} onChange={(e) => update(() => setTo(e.target.value))} /></label>
        <label>对局状态<select value={status} onChange={(e) => update(() => setStatus(e.target.value as typeof status))}><option value="finished">仅已完成</option><option value="">全部已归档</option><option value="abandoned">主动结束</option><option value="interrupted">中断</option></select></label></div>
      <p className="data-note">按开局日期筛选，北京时间。多局汇总覆盖全部匹配记录，不受下方分页影响。{Boolean(data?.active) && `另有 ${data!.active} 局进行中，结束后可分析。`}</p></section>
    {loading && <p role="status" className="data-loading">正在整理牌局档案…</p>}{error && <div className="data-error" role="alert">{error}<button onClick={() => setRefresh((r) => r + 1)}>重试</button></div>}
    {data && !loading && <><div className="data-stats" aria-label="多局统计"><Stat label="归档对局" value={number(overview!.total)} unit="局" note={`${overview!.finished} 局完成 · ${overview!.incomplete} 局未完成`} /><Stat label={selected ? selected.name + '的胜率' : '有效动作'} value={selected ? percent(selected.wins, selected.completed) : number(overview!.steps)} unit={selected ? '' : '步'} note={selected ? `${selected.wins} 胜 / ${selected.completed} 局完成` : '当前玩家范围内的全部动作'} /><Stat label="真人操作" value={number(overview!.humanSteps)} unit="步" note="排除系统兜底的真人动作" /><Stat label="系统兜底" value={number(overview!.fallbackSteps)} unit="步" note="导出时单独标注来源" /></div>
      {data.total ? <><BatchCharts data={data} profileId={profileId} /><section className="data-panel"><div className="data-section-title"><div><span className="game-kicker">PLAYING STYLE</span><h2>习惯，藏在每一次选择里</h2></div><span className="data-tag">{gameLabels[game]}</span></div>
        <p className="data-note">{game === 'bluff' ? '吹牛率 = 含假牌的出牌 / 全部出牌；质疑率 = 质疑 / 回应；质疑成功率 = 抓到假牌 / 质疑。' : '不出率 = 不出 / 出牌阶段动作；炸弹率 = 炸弹或火箭 / 出牌。地主、农民胜率分别统计。'} 胜率仅计完成局，分母为 0 时显示 —。</p>
        <div className="data-table-scroll"><table className="data-table"><thead><tr><th>玩家 / 样本</th><th>胜率</th><th>{game === 'bluff' ? '吹牛率' : '不出率'}</th><th>{game === 'bluff' ? '质疑率' : '炸弹率'}</th><th>{game === 'bluff' ? '质疑成功率' : '地主 / 农民胜率'}</th><th>平均每次出牌</th></tr></thead><tbody>{overview!.players.filter((p) => !profileId || p.profileId === profileId).map((p) => <StyleRow key={p.profileId} player={p} game={game} />)}</tbody></table></div>
        <p className="data-note">这些指标描述当前样本，不代表固定性格或策略优劣。少于 20 局标记为“积累中”；模型名或策略名变化会分开归档。含兜底的动作仍计入描述统计，训练时可按来源排除。</p></section></> : <section className="data-empty"><span aria-hidden="true">♧</span><h2>你的故事，从下一局开始。</h2><p>这个范围还没有归档对局。完成几局，或切换筛选条件，数据就会在这里慢慢长出来。</p><a className="primary" href="/">回大厅玩一局 ↗</a></section>}
      <section className="data-panel"><div className="data-section-title"><div><span className="game-kicker">MATCH ARCHIVE</span><h2>一局一页，随时翻看</h2></div><span className="data-note">共 {data.total} 局</span></div>
        {data.games.length > 0 && <div className="data-table-scroll"><table className="data-table data-games"><thead><tr><th>开局时间</th><th>牌桌</th><th>玩家</th><th>结果</th><th>动作</th><th><span className="sr-only">查看</span></th></tr></thead><tbody>{data.games.map((match) => <tr key={match.id}><td>{dataDate(match.startedAt)}{match.imported && <small>旧存档 · 时间为结算时间</small>}</td><td>{gameLabels[match.game]}<small>第 {match.generation} 局</small></td><td>{match.players.map((p) => p.name).join(' / ')}</td><td><span className={'data-status ' + match.status}>{statusLabels[match.status]}</span><small>{match.status === 'finished' ? match.players.filter((p) => p.won).map((p) => p.name).join('、') + '胜' : '保留已发生的动作'}</small></td><td>{match.steps}</td><td><button onClick={() => setEpisodeId(match.id)}>复盘 ↗</button></td></tr>)}</tbody></table></div>}
        <div className="data-pagination"><span>{data.total ? offset + 1 : 0}–{Math.min(offset + data.limit, data.total)} / {data.total}</span><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - data.limit))}>上一页</button><button disabled={offset + data.limit >= data.total} onClick={() => setOffset(offset + data.limit)}>下一页</button></div></section>
      <section className="data-bottom-grid"><div className="data-panel data-export"><span className="game-kicker">KEEP EVERY DECISION</span><h2>把今天的对局，留给未来的 AI。</h2><p>导出当前筛选范围，供后续行为克隆与强化学习使用。完整档案保留初始牌局与全部动作；决策样本还原行动者当时可见的信息。</p><div className="data-downloads"><a href={exportUrl(filter, 'episodes')} download>完整档案 JSONL ↓</a><a href={exportUrl(filter, 'transitions')} download>决策样本 JSONL ↓</a></div><p className="data-note">选择某个玩家，可只导出他的决策样本。含规则版本、玩家 ID、动作来源和终局标记；不包含 API key。<a href="/data-guide" target="_blank" rel="noreferrer">查看数据说明 ↗</a></p><p className="data-storage">● {data.storage.persistent ? '已开启本地数据库持久保存' : '当前为内存存储，服务关闭后数据会丢失'}</p></div>
        <div className="data-panel"><span className="game-kicker">PLAYER IDENTITY</span><h2>这局，你是谁？</h2><p className="data-note">固定档案让多局行为累积到同一个人。选择只影响之后新建的房间，已有对局保持原身份。</p><label className="data-profile-select">下次开局身份<select value={identity.id} onChange={(e) => { const p = data.profiles.find((p) => p.id === e.target.value); if (p) { try { selectProfile(p); setIdentity(p); setProfileError(''); } catch { setProfileError('浏览器无法保存身份，请允许本地存储后重试。'); } } }}>{!data.profiles.some((p) => p.id === identity.id) && <option value={identity.id}>档案已不存在，请重新选择</option>}{data.profiles.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.id === 'human_local' ? '默认' : p.id.slice(-6)}</option>)}</select></label>
          <form className="data-profile-form" onSubmit={(event) => void addProfile(event)}><label>新玩家名字<input value={name} maxLength={32} placeholder="例如：小林" onChange={(e) => setName(e.target.value)} /></label><button type="submit" disabled={!name.trim() || saving}>{saving ? '保存中…' : '创建并使用'}</button></form>{profileError && <p role="alert">{profileError}</p>}<p className="data-note">本机玩家档案。旧记录不会仅因同名就自动合并。</p></div></section>
    </>}
    <footer className="club-footer"><span>AI DOU · 每一手，都值得被记住。</span><span>DATA / V1</span></footer></main>{episodeId && <DataEpisode id={episodeId} close={() => setEpisodeId(null)} />}</div>;
}

function Stat({ label, value, unit, note }: { label: string; value: string; unit: string; note: string }) { return <div><span>{label}</span><strong>{value}<small>{unit}</small></strong><p>{note}</p></div>; }
function StyleRow({ player: p, game }: { player: PlayerAggregate; game: GameKind }) {
  const m = p.metrics;
  return <tr><td><b>{p.name}</b><small>{p.kind === 'human' ? '真人' : p.kind === 'deepseek' || p.kind === 'model' ? '模型' : p.kind} · {p.games} 局 · {p.profileId === 'human_local' ? '默认' : p.profileId.slice(-6)}{p.games < 20 && ' · 积累中'}</small></td><td>{rate(p.wins, p.completed)}</td><td>{game === 'bluff' ? rate(m.bluffs, m.plays) : rate(m.passes, m.passes + m.plays)}</td><td>{game === 'bluff' ? rate(m.challenges, m.responses) : rate(m.bombs, m.plays)}</td><td>{game === 'bluff' ? rate(m.challengesWon, m.challenges) : <><strong>{percent(p.roles['地主']?.wins ?? 0, p.roles['地主']?.games ?? 0)} / {percent(p.roles['农民']?.wins ?? 0, p.roles['农民']?.games ?? 0)}</strong><small>分角色统计完成局</small></>}</td><td><strong>{m.plays ? (m.cardsPlayed / m.plays).toFixed(2) : '—'} 张</strong><small>{m.cardsPlayed} 张 / {m.plays} 次</small></td></tr>;
}

function BatchCharts({ data, profileId }: { data: DataResponse; profileId: string }) {
  const [metric, setMetric] = useState<'games' | 'actions' | 'wins' | 'distribution'>('games');
  const [chart, setChart] = useState<AnalysisChartType | 'auto'>('auto');
  const selectedMetric = metric === 'wins' && !profileId ? 'games' : metric;
  const dataset = useMemo<AnalysisDataset>(() => {
    const trend = data.overview.trend;
    const label = { games: '每日对局数', actions: '每日动作数', wins: '每日胜率', distribution: '动作分布' }[selectedMetric];
    const points = selectedMetric === 'distribution' ? Object.entries(data.overview.distribution).map(([x, y]) => ({ x, y, series: '当前玩家范围', steps: [] })) : trend.filter((d) => selectedMetric !== 'wins' || d.completed > 0).map((d) => ({ x: d.day, y: selectedMetric === 'wins' ? d.wins / d.completed * 100 : d[selectedMetric], series: label, steps: [] }));
    return { metric: 'actions', measureLabel: label, orderedTrend: selectedMetric !== 'distribution', categorical: true, xLabel: selectedMetric === 'distribution' ? '动作类别' : '日期', yLabel: selectedMetric === 'wins' ? '%' : selectedMetric === 'games' ? '局' : '次', points, observations: points.length, missing: 0 };
  }, [data, selectedMetric]);
  const ava = useMemo(() => runAvaAnalysis(dataset), [dataset]);
  const type = chart === 'auto' ? ava.recommendations[0]?.type ?? 'column_chart' : chart;
  return <div className="data-chart-grid"><section className="data-panel data-chart-panel"><div className="data-section-title"><div><span className="game-kicker">PATTERNS OVER TIME</span><h2>把多局，连成一幅图</h2></div><span className="analysis-badge">AntV AVA</span></div>
    <div className="data-chart-controls"><label>批量指标<select value={selectedMetric} onChange={(e) => { setMetric(e.target.value as typeof metric); setChart('auto'); }}><option value="games">每日对局数</option><option value="actions">每日动作数</option>{profileId && <option value="wins">每日胜率</option>}<option value="distribution">动作分布</option></select></label><label>图表<select value={chart} onChange={(e) => setChart(e.target.value as typeof chart)}><option value="auto">AVA 自动推荐</option><option value="column_chart">柱状图</option>{selectedMetric !== 'distribution' && <option value="line_chart">折线图</option>}</select></label></div>
    {dataset.points.length ? <AnalysisChart key={selectedMetric + type} dataset={dataset} type={type} /> : <p>当前范围没有可绘制的数据。</p>}<p className="data-note">{selectedMetric === 'wins' ? '仅统计每日完成局；每日分母不同，日胜率不做简单平均。' : selectedMetric === 'distribution' ? '按当前玩家范围汇总全部动作次数。' : '日期图仅显示有对局的日期；日期之间可能有间隔。'} {ava.recommendations.length ? 'AVA 推荐：' + ava.recommendations.map((a) => chartLabels[a.type]).join('、') + '。' : 'AVA 暂无合适推荐，使用默认柱状图。'}</p></section>
    <aside className="data-panel data-insights"><span className="game-kicker">AVA INSIGHTS</span><h2>数据里，有什么线索？</h2><span className="data-insight-mark" aria-hidden="true">✳</span>{ava.insights.length ? <ul>{ava.insights.map((insight, i) => <li key={i}>{insight.text}</li>)}</ul> : <p>{dataset.points.length < 3 ? `当前只有 ${dataset.points.length} 个${selectedMetric === 'distribution' ? '动作类别' : '日期数据点'}，尚不足以检测统计模式。` : '当前范围没有检测到显著模式，这同样是有效的分析结果。'}</p>}<p className="data-note">AVA 在本地分析统计规律，不调用游戏模型，也不会额外消耗 API 额度。统计显著不等于因果关系。</p>{ava.errors.map((e) => <p key={e} role="status">{e}</p>)}</aside></div>;
}
