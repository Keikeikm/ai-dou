import { reportedCache } from '../../shared/analysis-support.js';
export { reportedCache } from '../../shared/analysis-support.js';
import type { ModelResponse, TurnRecord } from './types.js';



export function summarizeCache(turns: readonly TurnRecord[]) {
  const responses = turns.flatMap((turn) => turn.modelResponse ? [turn.modelResponse] : []);
  const reported = responses.flatMap((response) => {
    const cache = reportedCache(response.usage);
    return cache ? [cache] : [];
  });
  const hit = reported.reduce((total, cache) => total + cache.hit, 0);
  const miss = reported.reduce((total, cache) => total + cache.miss, 0);
  const total = hit + miss;
  return { responses: responses.length, reported: reported.length, hit, miss,
    rate: total > 0 && Number.isSafeInteger(total) ? hit / total : null };
}
