import { analysisDataset, analysisRows, metricLabels, type AnalysisMetric } from './replay-analysis.js';
import type { AnalysisReplay, AnalysisScope } from './replay-chat.js';

export const avaChartLabels = {
  line: '折线图', column: '柱状图', bar: '条形图', pie: '饼图 / 环图', area: '面积图', scatter: '散点图',
  'dual-axes': '双轴图', histogram: '直方图', boxplot: '箱线图', violin: '小提琴图', radar: '雷达图',
  funnel: '漏斗图', waterfall: '瀑布图', liquid: '水波进度图', 'word-cloud': '词云图', venn: '韦恩图',
  treemap: '矩形树图', sankey: '桑基图', table: '数据表',
} as const;
export type AvaChartType = keyof typeof avaChartLabels;
export interface AvaVisualization { chartType: AvaChartType; config: Record<string, unknown> }
export class ChartDataError extends Error {}
export interface ChartSelection {
  metric: AnalysisMetric; seat: number | 'all'; xMetric?: AnalysisMetric; yMetric?: AnalysisMetric;
}
export function isAvaChartType(value: unknown): value is AvaChartType {
  return typeof value === 'string' && Object.hasOwn(avaChartLabels, value);
}

const label = (value: unknown) => String(value).slice(0, 200).replace(/[<>&"']/g, (character) =>
  ({ '<': '＜', '>': '＞', '&': '＆', '"': '＂', "'": '＇' })[character]!);

export function chartSource(replay: AnalysisReplay, scope: AnalysisScope, selection: ChartSelection) {
  const dataset = analysisDataset(replay, selection.metric, selection.seat, scope.from, scope.to);
  const rows = analysisRows(replay).filter((row) => row.step >= scope.from && row.step <= scope.to && (selection.seat === 'all' || row.seat === selection.seat));
  return { metric: metricLabels[selection.metric], unit: dataset.yLabel, categorical: dataset.categorical,
    observations: dataset.observations, missing: dataset.missing,
    points: dataset.points.map((point) => ({ position: point.x, value: point.y, player: point.series })),
    // A fixed projection: no card faces, seed, model response text or credentials.
    rows: rows.map((row) => ({ step: row.step, seat: row.seat, player: row.player, action: row.action, combination: row.combination,
      cards: row.cards, remaining: row.remaining, duration: row.duration, tokens: row.tokens, cache: row.cache })),
  };
}

// The model may choose presentation settings, but chart values always come
// from complete server-filtered observations, never from generated JSON data.
export function buildAvaChart(replay: AnalysisReplay, scope: AnalysisScope, selection: ChartSelection,
  chartType: AvaChartType, settings: Record<string, unknown> = {}): AvaVisualization {
  const data = analysisDataset(replay, selection.metric, selection.seat, scope.from, scope.to);
  if (!data.points.length) throw new ChartDataError('当前范围没有该指标的有效数据。');
  const points = data.points.map((point) => ({ ...point, series: label(point.series) }));
  const series = [...new Set(points.map((point) => point.series))];
  const config: Record<string, unknown> = { type: chartType, title: `${metricLabels[selection.metric]} · 第 ${scope.from}–${scope.to} 步`,
    axisXTitle: data.xLabel, axisYTitle: data.yLabel };
  for (const key of ['title', 'axisXTitle', 'axisYTitle'] as const) if (typeof settings[key] === 'string') config[key] = label(settings[key]);
  if (['default', 'light', 'dark', 'academy'].includes(String(settings.theme))) config.theme = settings.theme;
  if (typeof settings.stack === 'boolean' && ['area', 'column', 'bar'].includes(chartType)) config.stack = settings.stack;
  if (typeof settings.align === 'boolean' && chartType === 'radar') config.align = settings.align;
  const requireCategories = () => { if (!data.categorical) throw new ChartDataError('此图需要动作或牌型类别数据，请切换指标。'); };
  const requireObservations = () => { if (data.categorical) throw new ChartDataError('分布图需要原始数值观测，请选择手牌、耗时、Token 或缓存指标。'); };
  switch (chartType) {
    case 'line': case 'area':
      requireObservations();
      config.data = points.map((point) => ({ time: String(point.x), value: point.y, group: point.series }));
      break;
    case 'column': case 'bar':
      config.data = points.map((point) => ({ category: label(point.x), value: point.y, group: point.series }));
      config.group = series.length > 1;
      break;
    case 'pie':
      requireCategories();
      config.data = points.map((point) => ({ category: `${point.series} · ${label(point.x)}`, value: point.y }));
      if (typeof settings.innerRadius === 'number' && settings.innerRadius >= 0 && settings.innerRadius <= 0.8) config.innerRadius = settings.innerRadius;
      break;
    case 'scatter': case 'dual-axes': {
      requireObservations();
      const xMetric = selection.xMetric ?? (chartType === 'dual-axes' ? 'duration' : undefined);
      const yMetric = selection.yMetric ?? (chartType === 'dual-axes' ? 'tokens' : selection.metric);
      if (!xMetric) {
        config.data = points.map((point) => ({ x: Number(point.x), y: point.y, group: point.series }));
        break;
      }
      if (['actions', 'combinations'].some((metric) => metric === xMetric || metric === yMetric)) throw new ChartDataError('相关性和双轴图需要两个数值指标。');
      const xData = analysisDataset(replay, xMetric, selection.seat, scope.from, scope.to);
      const yData = analysisDataset(replay, yMetric, selection.seat, scope.from, scope.to);
      const yValues = new Map(yData.points.map((point) => [`${point.series}:${point.x}`, point.y]));
      const pairs = xData.points.flatMap((point) => {
        const y = yValues.get(`${point.series}:${point.x}`);
        return y === undefined ? [] : [{ step: Number(point.x), player: label(point.series), x: point.y, y }];
      });
      if (!pairs.length) throw new ChartDataError('所选两个指标没有同一玩家、同一步骤的共同有效记录。');
      if (chartType === 'scatter') {
        config.data = pairs.map((point) => ({ x: point.x, y: point.y, group: point.player }));
        config.axisXTitle = `${metricLabels[xMetric]} (${xData.yLabel})`; config.axisYTitle = `${metricLabels[yMetric]} (${yData.yLabel})`;
      } else {
        config.categories = pairs.map((point) => `${point.player} · 第 ${point.step} 步`);
        config.series = [{ type: 'column', axisYTitle: `${metricLabels[xMetric]} (${xData.yLabel})`, data: pairs.map((point) => point.x) },
          { type: 'line', axisYTitle: `${metricLabels[yMetric]} (${yData.yLabel})`, data: pairs.map((point) => point.y) }];
      }
      break;
    }
    case 'histogram':
      requireObservations(); config.data = points.map((point) => point.y);
      config.binNumber = typeof settings.binNumber === 'number' && Number.isInteger(settings.binNumber) ? Math.max(1, Math.min(50, settings.binNumber)) : Math.min(10, points.length);
      config.axisXTitle = `${metricLabels[selection.metric]} (${data.yLabel})`; config.axisYTitle = '记录数';
      break;
    case 'boxplot': case 'violin':
      requireObservations();
      if (series.some((name) => points.filter((point) => point.series === name).length < 3)) throw new ChartDataError('分布比较需要每位玩家至少 3 条有效记录。');
      config.data = points.map((point) => ({ category: point.series, value: point.y })); config.axisXTitle = '玩家';
      break;
    case 'radar':
      requireCategories(); config.data = points.map((point) => ({ name: label(point.x), value: point.y, group: point.series }));
      break;
    case 'funnel': {
      if (selection.metric !== 'hands' || series.length !== 1) throw new ChartDataError('漏斗图请选定一位玩家的手牌指标，用剩余张数表示出牌进度。');
      const ordered = [...points].sort((a, b) => Number(a.x) - Number(b.x));
      if (ordered.some((point, index) => index > 0 && point.y > ordered[index - 1].y)) throw new ChartDataError('此范围手牌有增加（如地主取得底牌），不满足漏斗图逐阶段递减的条件。');
      const stages = ordered.filter((point, index) => index === 0 || index === ordered.length - 1 || point.y !== ordered[index - 1].y);
      config.data = stages.map((point) => ({ category: `第 ${point.x} 步`, value: point.y })); break;
    }
    case 'waterfall': {
      if (selection.metric === 'hands') {
        if (series.length !== 1) throw new ChartDataError('手牌增减瀑布图请选定一位玩家。');
        const ordered = [...points].sort((a, b) => Number(a.x) - Number(b.x));
        config.data = [{ category: `第 ${ordered[0].x} 步初始`, value: ordered[0].y },
          ...ordered.slice(1).map((point, index) => ({ category: `第 ${point.x} 步变化`, value: point.y - ordered[index].y })), { category: '最终剩余', isTotal: true }];
      } else {
        config.data = [...points.map((point) => ({ category: `${point.series} · ${label(point.x)}`, value: point.y })), { category: '合计', isTotal: true }];
      } break;
    }
    case 'liquid': {
      if (selection.metric === 'cache') config.percent = points.reduce((sum, point) => sum + point.y, 0) / points.length / 100;
      else if (selection.metric === 'hands') {
        let maximum = 0, remaining = 0;
        for (const name of series) {
          const group = points.filter((point) => point.series === name).sort((a, b) => Number(a.x) - Number(b.x));
          maximum += Math.max(...group.map((point) => point.y)); remaining += group.at(-1)!.y;
        }
        config.percent = maximum ? (maximum - remaining) / maximum : 1;
        config.title = '当前范围的出牌进度（按各玩家最多手牌张数计算）';
      } else throw new ChartDataError('进度图仅支持手牌出牌进度或缓存命中率。');
      config.shape = 'circle'; break;
    }
    case 'word-cloud':
      requireCategories(); config.data = points.map((point) => ({ text: `${point.series} · ${label(point.x)}`, value: point.y })); break;
    case 'venn': {
      requireCategories();
      const groups = series.map((name) => new Set(points.filter((point) => point.series === name).map((point) => String(point.x))));
      config.data = Array.from({ length: (1 << series.length) - 1 }, (_, index) => {
        const members = series.map((_, i) => i).filter((i) => ((index + 1) & (1 << i)) !== 0);
        return { sets: members.map((i) => series[i]), value: [...groups[members[0]]].filter((category) => members.every((i) => groups[i].has(category))).length };
      }); config.title = '玩家已执行动作 / 牌型类别的交集（类别数）'; break;
    }
    case 'treemap':
      requireCategories(); config.data = series.map((name) => ({ name, value: points.filter((point) => point.series === name).reduce((sum, point) => sum + point.y, 0), children: points.filter((point) => point.series === name).map((point) => ({ name: label(point.x), value: point.y })) })); break;
    case 'sankey':
      requireCategories(); config.data = points.map((point) => ({ source: point.series, target: `${metricLabels[selection.metric]} · ${label(point.x)}`, value: point.y })); break;
    case 'table':
      config.data = points.map((point) => ({ 玩家: point.series, [data.xLabel]: label(point.x), [metricLabels[selection.metric]]: point.y, 单位: data.yLabel })); break;
  }
  return { chartType, config };
}
