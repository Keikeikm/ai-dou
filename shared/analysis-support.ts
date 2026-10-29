import type { ModelResponse, TurnRecord } from '../server/rooms/scheduler.js';

export const combinationNames: Record<string, string> = {
  single: '单牌', pair: '对子', triple: '三张', 'triple-single': '三带一', 'triple-pair': '三带二', straight: '顺子',
  'pair-straight': '连对', airplane: '飞机', 'airplane-single': '飞机带单', 'airplane-pair': '飞机带对', 'four-with-two': '四带二', 'four-with-two-pairs': '四带两对', bomb: '炸弹', rocket: '王炸',
};

export function origin(turn?: TurnRecord, room?: { players: readonly { seat: number; kind: string }[] }) {
  if (!turn) return { kind: 'unknown', text: '尚无决策' };
  if (turn.source === 'fallback') return { kind: 'fallback', text: '系统托管 · ' + ({ timeout: '超时', invalid: '非法决策', error: '异常' }[turn.reason ?? 'error']) };
  const playerKind = room?.players.find((player) => player.seat === turn.seat)?.kind;
  if (turn.source === 'human' || turn.decisionKind === 'human' || playerKind === 'human') return { kind: 'human', text: '真人操作' };
  const kind = turn.decisionKind ?? (playerKind === 'deepseek' ? 'model' : ['random', 'greedy'].includes(playerKind ?? '') ? 'bot' : playerKind === 'http' ? 'http' : 'unknown');
  return { kind, text: ({ model: '模型决策', bot: 'Bot 决策', http: 'HTTP Agent 决策', human: '真人操作', unknown: '旧日志来源未记录' })[kind] };
}

export function reportedCache(usage?: ModelResponse['usage']) {
  const hit = usage?.cacheHitTokens;
  const miss = usage?.cacheMissTokens;
  if (hit === undefined || miss === undefined || !Number.isSafeInteger(hit) || !Number.isSafeInteger(miss) || hit < 0 || miss < 0) return null;
  const total = hit + miss;
  if (!Number.isSafeInteger(total) || (usage?.promptTokens !== undefined && total !== usage.promptTokens)) return null;
  return { hit, miss, total, rate: total ? hit / total : null };
}
