import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { runAvaAnalysis, type AvaAnalysis } from '../../client/domain/ava-analysis.js';
import { useAvaAnalysis } from '../../client/hooks/useAvaAnalysis.js';
import type { AnalysisDataset } from '../../shared/replay-analysis.js';

vi.mock('../../client/domain/ava-analysis.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../client/domain/ava-analysis.js')>(), runAvaAnalysis: vi.fn(),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('clears old statistics on filter changes and ignores late results from the old range', async () => {
  const first: AnalysisDataset = { metric: 'hands', categorical: false, xLabel: '步骤', yLabel: '张', observations: 1, missing: 0,
    points: [{ x: 0, y: 17, series: '玩家', steps: [0] }] };
  const second = { ...first, points: [{ ...first.points[0], y: 3 }] };
  let resolveFirst!: (value: AvaAnalysis) => void;
  let resolveSecond!: (value: AvaAnalysis) => void;
  vi.mocked(runAvaAnalysis).mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
    .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
  const view = renderHook(({ data }) => useAvaAnalysis(data), { initialProps: { data: first } });
  view.rerender({ data: second });
  expect(view.result.current.stats).toBeNull();
  await act(async () => resolveSecond({ recommendations: [], insights: [], errors: [], stats: { mean: 3, min: 3, max: 3 } }));
  await act(async () => resolveFirst({ recommendations: [], insights: [], errors: [], stats: { mean: 17, min: 17, max: 17 } }));
  expect(view.result.current.stats?.mean).toBe(3);
});
