import type { AnalysisDataset } from './replay-analysis.js';
import { replayPatterns } from './replay-patterns.js';

export type AnalysisChartType = 'line_chart' | 'column_chart' | 'grouped_column_chart' | 'scatter_plot';
export const chartLabels: Record<AnalysisChartType, string> = { line_chart: '折线图', column_chart: '柱状图', grouped_column_chart: '分组柱状图', scatter_plot: '散点图' };
export interface AnalysisInsight { text: string; steps: number[] }
export interface AvaAnalysis {
  recommendations: { type: AnalysisChartType }[];
  insights: AnalysisInsight[];
  stats: { mean: number; min: number; max: number } | null;
  errors: string[];
}

// V4 recommendation is model-backed. Keep offline chart choices deterministic
// rather than making a model call when a filter changes.
export function defaultChartType(dataset: AnalysisDataset): AnalysisChartType {
  if (dataset.categorical) return new Set(dataset.points.map((point) => point.series)).size > 1 ? 'grouped_column_chart' : 'column_chart';
  return dataset.metric === 'hands' ? 'line_chart' : 'scatter_plot';
}

export async function runAvaAnalysis(dataset: AnalysisDataset): Promise<AvaAnalysis> {
  const result: AvaAnalysis = { recommendations: [], insights: [], stats: null, errors: [] };
  if (!dataset.points.length) return result;
  result.recommendations = [{ type: defaultChartType(dataset) }];
  // The public browser entry works in Node and browsers and avoids loading
  // native database engines. AVA 4.0.0 supports standard ESM imports.
  // source(json) and profile() do not call a model; V4 requires an LLM config
  // even for these operations, but no credentials are supplied or needed here.
  let ava: import('@antv/ava/browser').AVA | undefined;
  try {
    const { AVA } = await import('@antv/ava/browser');
    ava = new AVA({ engine: { type: 'javascript' }, llm: { model: 'unused-local-profile' } });
    await ava.source({ type: 'json', options: { data: dataset.points.map((point) => ({ value: point.y })) } });
    const profile = await ava.profile({ metrics: ['mean', 'min', 'max'] });
    const metrics = profile.models[0]?.columns.find((column) => column.name === 'value')?.metrics;
    const mean = metrics?.mean, min = metrics?.min, max = metrics?.max;
    if (typeof mean !== 'number' || typeof min !== 'number' || typeof max !== 'number' || ![mean, min, max].every(Number.isFinite)) {
      throw new Error('Invalid AVA profile');
    }
    result.stats = { mean, min, max };
  } catch { result.errors.push('AVA 数据统计暂不可用'); }
  finally { await ava?.dispose(); }
  // V4 removed the V3 insight extractors. These are application-owned rules.
  result.insights = replayPatterns(dataset);
  return result;
}
