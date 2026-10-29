import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelCacheSummary, ModelResponsePanel } from '../../client/components/ModelResponse.js';
import { reportedCache, summarizeCache } from '../../client/domain/model-usage.js';
import type { ModelResponse, TurnRecord } from '../../client/domain/types.js';

afterEach(cleanup);
function turn(usage?: ModelResponse['usage'], status: ModelResponse['status'] = 'accepted'): TurnRecord {
  return { sequence: 1, seat: 0, phase: 'calling', action: { type: 'call', score: 0 }, source: status === 'accepted' ? 'agent' : 'fallback', decisionKind: 'model',
    modelResponse: { provider: 'deepseek', model: 'deepseek-flash', durationMs: 5, status, ...(usage ? { usage } : {}) } };
}

describe('model cache reporting', () => {
  it('distinguishes reported zero hits from absent cache counters', () => {
    expect(reportedCache({ promptTokens: 100, cacheHitTokens: 0, cacheMissTokens: 100 })).toEqual({ hit: 0, miss: 100, total: 100, rate: 0 });
    expect(reportedCache({ cacheHitTokens: 0, cacheMissTokens: 0 })).toEqual({ hit: 0, miss: 0, total: 0, rate: null });
    expect(reportedCache({ promptTokens: 100 })).toBeNull();
    expect(reportedCache({ cacheHitTokens: 20 })).toBeNull();
  });

  it.each([
    { cacheHitTokens: -1, cacheMissTokens: 10 }, { cacheHitTokens: 1.5, cacheMissTokens: 10 },
    { cacheHitTokens: Infinity, cacheMissTokens: 10 }, { cacheHitTokens: Number.MAX_SAFE_INTEGER, cacheMissTokens: 10 },
    { promptTokens: 100, cacheHitTokens: 80, cacheMissTokens: 30 },
  ])('does not calculate rates from inconsistent or unsafe counters: %j', (usage) => {
    expect(reportedCache(usage)).toBeNull();
  });

  it('aggregates weighted cache rates only over complete reported responses, including invalid replies', () => {
    const summary = summarizeCache([
      turn({ promptTokens: 100, cacheHitTokens: 80, cacheMissTokens: 20 }),
      turn({ promptTokens: 10, cacheHitTokens: 10, cacheMissTokens: 0 }, 'invalid'), turn({ promptTokens: 100 }), turn(undefined, 'error'),
    ]);
    expect(summary).toMatchObject({ responses: 4, reported: 2, hit: 90, miss: 20 });
    expect(summary.rate).toBeCloseTo(90 / 110);
  });

  it('shows the selected skill, fingerprint, real cache counters and rate on the matching response', () => {
    const record = turn({ promptTokens: 100, completionTokens: 5, totalTokens: 105, cacheHitTokens: 80, cacheMissTokens: 20 });
    const modelResponse: ModelResponse = { ...record.modelResponse!, strategy: { id: 'teamwork', name: '协作均衡型', version: 1, digest: 'abcdef1234567890' } };
    render(<ModelResponsePanel turn={{ ...record, modelResponse }} expanded />);
    expect(screen.getByText(/协作均衡型 v1/).textContent).toContain('abcdef123456');
    expect(screen.getByText(/上下文缓存/).textContent).toContain('命中 80 / 未命中 20 tokens · 命中率 80.0%');
  });

  it('marks missing cache statistics on old responses instead of displaying zero percent', () => {
    const record = turn({ promptTokens: 100 });
    render(<><ModelResponsePanel turn={record} expanded /><ModelCacheSummary turns={[record]} /></>);
    expect(screen.getByText(/上下文缓存/).textContent).toContain('命中 未报告 / 未命中 未报告');
    expect(screen.getByText(/尚无完整缓存统计/)).toBeTruthy();
    expect(screen.queryByText(/0.0%/)).toBeNull();
  });
});
