import { metricLabels, type AnalysisDataset, type AnalysisPoint } from './replay-analysis.js';
import type { AnalysisInsight } from './ava-analysis.js';

function quantile(sorted: number[], fraction: number): number {
  const index = (sorted.length - 1) * fraction;
  const low = Math.floor(index), high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

// Two-sided Mann–Kendall test at 95%, with tie and continuity corrections.
// Snapshots are ordered by game step, not fabricated timestamps.
function trend(points: AnalysisPoint[]): string | null {
  const ordered = [...points].sort((a, b) => Number(a.x) - Number(b.x));
  let score = 0;
  const ties = new Map<number, number>();
  for (let i = 0; i < ordered.length; i++) {
    ties.set(ordered[i].y, (ties.get(ordered[i].y) ?? 0) + 1);
    for (let j = i + 1; j < ordered.length; j++) score += Math.sign(ordered[j].y - ordered[i].y);
  }
  const n = ordered.length;
  const correction = [...ties.values()].reduce((sum, count) => sum + count * (count - 1) * (2 * count + 5), 0);
  const variance = (n * (n - 1) * (2 * n + 5) - correction) / 18;
  if (variance <= 0 || Math.abs(score - Math.sign(score)) / Math.sqrt(variance) <= 1.96) return null;
  return score < 0 ? '下降' : '上升';
}

export function replayPatterns(dataset: AnalysisDataset): AnalysisInsight[] {
  const insights: AnalysisInsight[] = [];
  const groups = new Map<string, AnalysisPoint[]>();
  for (const point of dataset.points) {
    const group = groups.get(point.series) ?? [];
    group.push(point); groups.set(point.series, group);
  }
  for (const [series, points] of groups) {
    if (points.length < 3) continue;
    const values = points.map((point) => point.y).sort((a, b) => a - b);
    const q1 = quantile(values, 0.25), q3 = quantile(values, 0.75), iqr = q3 - q1;
    for (const point of points) {
      if (point.y < q1 - 1.5 * iqr || point.y > q3 + 1.5 * iqr) {
        insights.push({ text: `${series} · ${dataset.categorical ? point.x : '第 ' + point.x + ' 步'}的${metricLabels[dataset.metric]}为 ${Number(point.y.toFixed(2))} ${dataset.yLabel}，本地 IQR 检测为离群值。`, steps: point.steps });
      }
    }
    if (dataset.categorical) {
      const total = values.reduce((sum, value) => sum + value, 0);
      for (const point of points) {
        if (total > 0 && point.y / total > 0.5) insights.push({ text: `${series} · ${point.x}占该玩家所选范围的 ${(point.y / total * 100).toFixed(1)}%，超过半数，为主要类别。`, steps: point.steps });
      }
      const mean = total / values.length;
      const deviation = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
      if (mean > 0 && deviation / mean <= 0.1) insights.push({ text: `${series} · 各类别次数接近（变异系数不超过 0.1）。`, steps: [] });
    }
    if (dataset.metric === 'hands' && points.length >= 5) {
      const direction = trend(points);
      if (direction) insights.push({ text: `${series} · 剩余手牌随历史步骤显著${direction}（本地 Mann–Kendall 检验）。`, steps: [] });
    }
  }
  return insights.slice(0, 6);
}
