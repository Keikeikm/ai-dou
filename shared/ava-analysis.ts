import { Advisor, DataFrame, getInsights, insightPatternsExtractor, type NumberFieldInfo, type PatternInfo } from '@antv/ava';
import { metricLabels, type AnalysisDataset, type AnalysisPoint } from './replay-analysis.js';

export type AnalysisChartType = 'line_chart' | 'column_chart' | 'grouped_column_chart' | 'scatter_plot';
export const chartLabels: Record<AnalysisChartType, string> = { line_chart: '折线图', column_chart: '柱状图', grouped_column_chart: '分组柱状图', scatter_plot: '散点图' };
export interface AnalysisInsight { text: string; steps: number[] }
export interface AvaAnalysis {
  recommendations: { type: AnalysisChartType; score: number }[];
  insights: AnalysisInsight[];
  stats: { mean: number; min: number; max: number } | null;
  errors: string[];
}

export function runAvaAnalysis(dataset: AnalysisDataset): AvaAnalysis {
  const result: AvaAnalysis = { recommendations: [], insights: [], stats: null, errors: [] };
  if (!dataset.points.length) return result;
  const data = dataset.points.map((point) => ({ [dataset.xLabel]: point.x, [metricLabels[dataset.metric]]: point.y, '玩家': point.series }));
  const measure = metricLabels[dataset.metric];
  try {
    const info = new DataFrame(data).info().find((field) => field.name === measure) as NumberFieldInfo | undefined;
    if (info && Number.isFinite(info.mean)) result.stats = { mean: info.mean, min: info.minimum, max: info.maximum };
  } catch { result.errors.push('AVA 数据统计暂不可用'); }
  try {
    const supported: AnalysisChartType[] = dataset.categorical ? ['column_chart', 'grouped_column_chart'] : ['line_chart', 'scatter_plot'];
    const advisor = new Advisor({ ckbCfg: { include: supported } });
    const singleSeries = new Set(dataset.points.map((point) => point.series)).size === 1;
    const adviceData = singleSeries ? dataset.points.map((point) => ({ [dataset.xLabel]: point.x, [measure]: point.y })) : data;
    result.recommendations = advisor.advise({ data: adviceData, smartColor: false,
      options: { ...(dataset.categorical ? { purpose: 'Comparison' as const } : {}), refine: false } })
      .filter((advice) => supported.includes(advice.type as AnalysisChartType) && Number.isFinite(advice.score) && advice.score > 0)
      .map((advice) => ({ type: advice.type as AnalysisChartType, score: advice.score }));
  } catch { result.errors.push('AVA 图表推荐暂不可用，可手动选择图表'); }
  try {
    const groups = new Map<string, AnalysisPoint[]>();
    for (const point of dataset.points) {
      const group = groups.get(point.series) ?? [];
      group.push(point); groups.set(point.series, group);
    }
    for (const [series, points] of groups) {
      if (points.length < 3) continue;
      const input = points.map((point) => ({ '位置': String(point.x), '数值': point.y }));
      const dimensions = [{ fieldName: '位置' }];
      const measures = [{ fieldName: '数值', method: 'SUM' as const }];
      const patterns: PatternInfo[] = dataset.categorical
        ? getInsights(input, { dimensions, measures, insightTypes: ['category_outlier', 'majority', 'low_variance'],
          ignoreSubspace: true, homogeneous: false, visualization: false, limit: 4 }).insights.flatMap((insight) => insight.patterns)
        : insightPatternsExtractor({ data: input, dimensions, measures, insightType: 'category_outlier', options: { filterInsight: true } });
      // The hand snapshots are equally spaced in game steps. This uses AVA's MK
      // ordered-series test directly; no dates or elapsed times are fabricated.
      if (dataset.metric === 'hands' && points.length >= 5) patterns.push(...insightPatternsExtractor({ data: input, dimensions, measures,
        insightType: 'trend', options: { filterInsight: true } }));
      for (const pattern of patterns) {
        if (pattern.significantInsight === false) continue;
        const insight = describePattern(pattern, points, series, dataset);
        if (insight) result.insights.push(insight);
      }
    }
    result.insights = result.insights.slice(0, 6);
  } catch { result.errors.push('AVA 自动洞察暂不可用，原始数据仍可查看'); }
  return result;
}

function describePattern(pattern: PatternInfo, points: AnalysisPoint[], series: string, dataset: AnalysisDataset): AnalysisInsight | null {
  if (pattern.type === 'category_outlier') {
    const point = points.find((candidate) => String(candidate.x) === String(pattern.x));
    return point ? { text: `${series} · ${dataset.categorical ? pattern.x : '第 ' + pattern.x + ' 步'}的${metricLabels[dataset.metric]}为 ${Number(pattern.y.toFixed(2))} ${dataset.yLabel}，AVA IQR 检测为离群值。`, steps: point.steps } : null;
  }
  if (pattern.type === 'majority') {
    const point = points.find((candidate) => String(candidate.x) === String(pattern.x));
    return point ? { text: `${series} · ${pattern.x}占该玩家所选范围的 ${(pattern.proportion * 100).toFixed(1)}%，AVA 检测为主要类别。`, steps: point.steps } : null;
  }
  if (pattern.type === 'low_variance') return { text: `${series} · 各类别次数接近，AVA 检测为低方差分布。`, steps: [] };
  if (pattern.type === 'trend' && pattern.trend !== 'no trend') return { text: `${series} · 剩余手牌随历史步骤显著${pattern.trend === 'decreasing' ? '下降' : '上升'}（AVA Mann–Kendall 检验）。`, steps: [] };
  return null;
}
