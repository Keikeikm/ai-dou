import { useMemo } from 'react';
import type { AnalysisChatReply, AnalysisReplay } from '../../shared/replay-chat.js';
import { analysisDataset, metricLabels } from '../domain/replay-analysis.js';
import { chartLabels, defaultChartType } from '../domain/ava-analysis.js';
import { AnalysisChart } from './AnalysisChart.js';
import { AvaChart } from './AvaChart.js';
import { avaChartLabels } from '../../shared/ava-charts.js';

export function AnalysisReplyChart({ replay, reply, seek }: { replay?: AnalysisReplay; reply: AnalysisChatReply; seek: (step: number) => void }) {
  const chart = reply.chart!;
  const dataset = useMemo(() => replay ? analysisDataset(replay, chart.metric, chart.seat, reply.scope.from, reply.scope.to) : null,
    [replay, chart.metric, chart.seat, reply.scope.from, reply.scope.to]);
  const type = chart.type ?? (dataset ? defaultChartType(dataset) : 'line_chart');
  return <section className="analysis-reply-chart" aria-label={`回答图表 · ${metricLabels[chart.metric]}`}>
    <h4>{metricLabels[chart.metric]} <small>{chart.visualization ? `${avaChartLabels[chart.visualization.chartType]} · AVA V4 推荐与生成` : `${chartLabels[type]} · 本地基础图`}</small></h4>
    {chart.metric === 'hands' && <p className="analysis-note">每一步结束后各玩家还剩多少张牌，帮助观察出牌进度；地主拿到底牌时增加 3 张。</p>}
    {chart.visualizationError && <p role="status">{chart.visualizationError}</p>}
    {chart.visualization ? <AvaChart visualization={chart.visualization} /> : dataset?.points.length ? <AnalysisChart dataset={dataset} type={type} seek={seek} />
      : <p role="status">当前范围没有可分析的{metricLabels[chart.metric]}数据。请选择其他指标或范围；未记录的数据不会按零绘制。</p>}
  </section>;
}
