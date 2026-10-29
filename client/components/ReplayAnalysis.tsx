import { useMemo, useState } from 'react';
import type { Replay } from '../domain/types.js';
import { analysisCsv, analysisDataset, analysisRows, metricLabels, type AnalysisMetric } from '../domain/replay-analysis.js';
import { chartLabels, runAvaAnalysis, type AnalysisChartType } from '../domain/ava-analysis.js';
import { AnalysisChart } from './AnalysisChart.js';
import { AnalysisChat } from './AnalysisChat.js';

export default function ReplayAnalysis({ replay, index, seek, source }: { replay: Replay; index: number; seek: (step: number) => void; source?: { kind: 'room' | 'archive'; id: string } }) {
  const last = Math.max(0, replay.snapshots.length - 1);
  const [metric, setMetric] = useState<AnalysisMetric>('hands');
  const [seat, setSeat] = useState<number | 'all'>('all');
  const [scope, setScope] = useState('all');
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(last);
  const [chart, setChart] = useState<AnalysisChartType | 'auto'>('auto');
  const [manualOpen, setManualOpen] = useState(false);
  const start = scope === 'custom' ? Math.min(from, last) : 0;
  const end = scope === 'all' ? last : scope === 'current' ? index : Math.max(start, Math.min(to, last));
  const dataset = useMemo(() => analysisDataset(replay, metric, seat, start, end), [replay, metric, seat, start, end]);
  const analysis = useMemo(() => runAvaAnalysis(dataset), [dataset]);
  const rows = useMemo(() => analysisRows(replay).filter((row) => row.step >= start && row.step <= end && (seat === 'all' || row.seat === seat)), [replay, start, end, seat]);
  const chartType = chart === 'auto' ? analysis.recommendations[0]?.type ?? (dataset.categorical ? 'grouped_column_chart' : 'line_chart') : chart;
  function exportCsv() {
    const url = URL.createObjectURL(new Blob([analysisCsv(rows)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `ai-dou-${replay.room.id}-${replay.generation}-${start}-${end}.csv`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="replay-analysis" aria-label="AVA 复盘分析">
    <div className="analysis-intro"><span className="analysis-badge">AntV AVA</span><h3>从数据回看这一局</h3>
      <p>第 {replay.generation} 局 · {last} 个历史步骤 · {replay.session.status === 'finished' ? '完整对局' : '已收到的对局数据'}。直接提问，让 AVA 帮你分析与生成图表。</p></div>
    <AnalysisChat replay={replay} source={source ?? { kind: replay.accounting?.gameId ? 'archive' : 'room', id: replay.accounting?.gameId ?? replay.room.id }}
      scope={{ generation: replay.generation, from: start, to: end, metric, seat }} seek={seek}
      showChart={(suggestion, captured) => { setMetric(suggestion.metric); setSeat(suggestion.seat); setScope('custom'); setFrom(captured.from); setTo(captured.to); setChart(suggestion.type ?? 'auto'); setManualOpen(true); }} />
    <details className="analysis-data analysis-scope"><summary>调整分析范围与指标 · {start}–{end} 步 · {seat === 'all' ? '全部玩家' : '席位 ' + (seat + 1)}</summary>
    <div className="analysis-filters">
      <label>分析指标<select value={metric} onChange={(event) => { setMetric(event.target.value as AnalysisMetric); setChart('auto'); }}>
        {Object.entries(metricLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>分析玩家<select value={seat} onChange={(event) => setSeat(event.target.value === 'all' ? 'all' : Number(event.target.value))}>
        <option value="all">全部玩家</option>{[0, 1, 2].map((s) => <option key={s} value={s}>{replay.room.players.find((p) => p.seat === s)?.name ?? '等待入座'} · 席位 {s + 1}</option>)}</select></label>
      <label>回合范围<select value={scope} onChange={(event) => setScope(event.target.value)}><option value="all">全部对局</option><option value="current">截至当前回放步</option><option value="custom">自定义范围</option></select></label>
      {scope === 'custom' && <><label>起始步骤<input type="number" min={0} max={last} value={start} onChange={(event) => setFrom(Math.max(0, Math.min(last, Math.trunc(Number(event.target.value)))))} /></label>
        <label>结束步骤<input type="number" min={start} max={last} value={end} onChange={(event) => setTo(Math.max(start, Math.min(last, Math.trunc(Number(event.target.value)))))} /></label></>}
    </div></details>
    <details className="analysis-data analysis-manual" open={manualOpen} onToggle={(event) => setManualOpen(event.currentTarget.open)}><summary>手动图表与统计摘要</summary>
    <div className="analysis-stats" aria-label="分析摘要"><div><small>历史范围</small><strong>{start}–{end} 步</strong></div>
      <div><small>有效数据点</small><strong>{dataset.points.length}</strong></div>
      <div><small>{dataset.categorical ? '各玩家类别平均次数' : '平均值'}</small><strong>{analysis.stats ? Number(analysis.stats.mean.toFixed(2)) + ' ' + dataset.yLabel : '未记录'}</strong></div>
      <div><small>最小 / 最大</small><strong>{analysis.stats ? Number(analysis.stats.min.toFixed(2)) + ' / ' + Number(analysis.stats.max.toFixed(2)) : '未记录'}</strong></div></div>
    {['duration', 'tokens', 'cache'].includes(metric) && <p className="analysis-note">模型记录覆盖：{dataset.observations - dataset.missing} / {dataset.observations}。仅统计包含模型回复的步骤；未记录值不按零计算，Bot、HTTP 和真人操作没有模型测量。{metric === 'cache' ? '平均值为逐次命中率的算术平均，按 token 加权的统计见“模型返回”。' : ''}</p>}
    {metric === 'hands' && <p className="analysis-note">手牌张数变化：每一步结束后各玩家还剩多少张牌，用来观察谁出牌更快、何时接近出完；它不表示手牌强弱。地主取得底牌时增加 3 张。平均值按玩家和快照计算。</p>}
    <div className="analysis-chart-heading"><h3>{metricLabels[metric]}</h3><label>图表类型<select value={chart} onChange={(event) => setChart(event.target.value as AnalysisChartType | 'auto')}>
      <option value="auto">自动推荐</option>{(dataset.categorical ? ['column_chart', 'grouped_column_chart'] as const : ['line_chart', 'column_chart', 'grouped_column_chart', 'scatter_plot'] as const).map((type) => <option key={type} value={type}>{chartLabels[type]}</option>)}</select></label></div>
    {analysis.recommendations.length > 0 ? <p className="analysis-recommendation">AVA 推荐：{analysis.recommendations.map((advice) => chartLabels[advice.type] + '（得分 ' + advice.score.toFixed(2) + '）').join(' / ')} · 推荐得分表示图表适配度。</p>
      : dataset.points.length > 0 && <p className="analysis-note">AVA 未给出适用推荐，使用默认{chartLabels[chartType]}。</p>}
    {dataset.points.length > 0 ? <AnalysisChart key={`${metric}:${seat}:${start}:${end}:${chartType}`} dataset={dataset} type={chartType} seek={seek} />
      : <div className="analysis-empty" role="status">当前范围没有可分析的{metricLabels[metric]}数据。{['duration', 'tokens', 'cache'].includes(metric) ? '可切换到手牌或动作指标；旧日志及非模型对局可能没有模型测量。' : '请选择其他范围，或在对局产生动作后查看。'}</div>}
    </details>
    <details className="analysis-data"><summary>AVA 自动洞察 · {analysis.insights.length} 条</summary><section className="analysis-insights" aria-label="AVA 自动洞察"><h3>AVA 自动洞察</h3>
      <p className="analysis-note">基于当前筛选数据的统计模式，不代表最佳出牌策略或因果关系。每位玩家至少 3 个数据点才进行分布检测，手牌趋势至少 5 个快照。</p>
      {analysis.insights.length ? <ul>{analysis.insights.map((insight, i) => <li key={i}>{insight.text}{insight.steps.length > 0 && <button className="quiet" onClick={() => seek(insight.steps[0])}>回看第 {insight.steps[0]} 步</button>}</li>)}</ul>
        : <p>当前数据未发现显著统计模式，或有效样本不足。</p>}
      {analysis.errors.map((error) => <p role="alert" key={error}>{error}</p>)}
    </section></details>
    <details className="analysis-data"><summary>查看数据表与逐步回看</summary>
    <div className="analysis-export"><strong>逐步数据 · {rows.length} 条</strong><button disabled={!rows.length} onClick={exportCsv}>导出筛选数据 CSV</button></div>
    <p className="analysis-note">导出当前玩家与回合范围的全部指标；空白表示未记录。分析与历史跳转在当前浏览器完成。</p>
    <div className="analysis-table-scroll"><table><caption>当前筛选范围的对局动作与模型测量</caption>
      <thead><tr>{['步骤', '玩家', '动作 / 牌型', '来源', '剩余张数', '耗时(ms)', 'Token', '缓存(%)'].map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
      <tbody>{rows.map((row) => <tr key={row.step}><td><button className="quiet" onClick={() => seek(row.step)}>第 {row.step} 步</button></td><td>{row.player} · {row.seat + 1}</td><td>{row.action}{row.combination && ' · ' + row.combination}</td><td>{row.source}</td>
        <td>{row.remaining ?? '未记录'}</td><td>{row.duration ?? '未记录'}</td><td>{row.tokens ?? '未记录'}</td><td>{row.cache === null ? '未记录' : row.cache.toFixed(1)}</td></tr>)}</tbody>
    </table>{!rows.length && <p>当前范围暂无动作记录。</p>}</div></details>
    <p className="analysis-credit">分析引擎：<a href="https://github.com/antvis/AVA" target="_blank" rel="noopener">AntV AVA</a> · 数据统计 / 图表推荐 / 模式检测</p>
  </section>;
}
