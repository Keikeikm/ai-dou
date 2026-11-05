import { describe, expect, it, vi } from 'vitest';
import { runAvaAnalysis } from '../shared/ava-analysis.js';
import { replayPatterns } from '../shared/replay-patterns.js';
import type { AnalysisDataset } from '../shared/replay-analysis.js';

function dataset(values: number[], metric: AnalysisDataset['metric'] = 'hands'): AnalysisDataset {
  return { metric, categorical: false, xLabel: '步骤', yLabel: '张', observations: values.length, missing: 0,
    points: values.map((y, x) => ({ x, y, series: '玩家', steps: [x] })) };
}

describe('AVA V4 migration', () => {
  it('profiles zeros and single points through the public Node export without network requests', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    try {
      expect((await runAvaAnalysis(dataset([0, 10, 20]))).stats).toEqual({ mean: 10, min: 0, max: 20 });
      expect((await runAvaAnalysis(dataset([0]))).stats).toEqual({ mean: 0, min: 0, max: 0 });
      expect((await runAvaAnalysis(dataset([]))).stats).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it('detects ordered trends with ties, but does not report constant or sparse hands as significant', () => {
    expect(replayPatterns(dataset([9, 9, 8, 8, 7, 7, 6, 6])).some((insight) => insight.text.includes('显著下降'))).toBe(true);
    expect(replayPatterns(dataset([6, 6, 7, 7, 8, 8, 9, 9])).some((insight) => insight.text.includes('显著上升'))).toBe(true);
    expect(replayPatterns(dataset([5, 5, 5, 5, 5, 5]))).toEqual([]);
    expect(replayPatterns(dataset([3, 2, 1])).some((insight) => insight.text.includes('显著'))).toBe(false);
  });

  it('detects outliers per player and preserves original replay step references', () => {
    const data = dataset([10, 11, 12, 10, 11, 12, 10, 1000], 'duration');
    data.points.push(...dataset([1000, 1000, 1000, 1000], 'duration').points.map((point) => ({ ...point, series: '其他玩家' })));
    const insights = replayPatterns(data);
    expect(insights).toHaveLength(1);
    expect(insights[0].steps).toEqual([7]);
    expect(insights[0].text).toContain('本地 IQR');
  });

  it('reports majority and similar positive counts without inventing a pattern for empty categories', () => {
    const categorical = (values: number[]) => ({ ...dataset(values, 'actions'), categorical: true });
    expect(replayPatterns(categorical([1, 12, 3])).some((insight) => insight.text.includes('主要类别'))).toBe(true);
    expect(replayPatterns(categorical([3, 3, 3])).some((insight) => insight.text.includes('次数接近'))).toBe(true);
    expect(replayPatterns(categorical([0, 0, 0]))).toEqual([]);
  });
});
