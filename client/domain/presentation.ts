import { combinationNames } from '../../shared/analysis-support.js';
import type { GameSnapshot, ModelResponse } from './types.js';

export const profiles = [
  { name: 'GPT大人', theme: 'violet', avatar: '/avatars/violet.png' },
  { name: 'Claude大小姐', theme: 'amber', avatar: '/avatars/amber.png' },
  { name: '鲸鱼娘', theme: 'azure', avatar: '/avatars/azure.png' },
];
export const ranks = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', 'little-joker', 'big-joker'];
export { combinationNames } from '../../shared/analysis-support.js';
export const errorLabels: Record<string, string> = {
  unauthorized: '鉴权失败，请检查 API key（401 / 403）', insufficient_balance: '账户余额不足（402）', rate_limited: '请求限流（429）',
  provider_error: '供应商服务异常', invalid_response: '回复格式不符合协议', timeout: '请求超时', cancelled: '请求已取消',
  dns_failed: 'DNS 解析或地址校验失败', tls_failed: 'TLS 证书校验失败', connection_failed: '网络连接失败，请检查服务联网权限', response_failed: '响应流中断',
};

export function responseFailure(response?: ModelResponse, reason?: string): string {
  if (response?.httpStatus) {
    const status = response.httpStatus;
    return status === 401 || status === 403 ? errorLabels.unauthorized : status === 402 ? errorLabels.insufficient_balance
      : status === 429 ? errorLabels.rate_limited : 'DeepSeek 返回 HTTP ' + status;
  }
  if (response?.error) return errorLabels[response.error];
  if (reason === 'timeout') return errorLabels.timeout;
  if (reason === 'invalid') return errorLabels.invalid_response;
  return '请求失败，旧日志未记录具体网络原因；不能据此判定密钥无效';
}

export { origin } from '../../shared/analysis-support.js';

export const latestAction = (snapshot?: GameSnapshot) => snapshot?.logs.findLast((entry) => ['call', 'play', 'pass'].includes(entry.action));
export function actionText(snapshot?: GameSnapshot): string {
  const action = latestAction(snapshot);
  if (!action) return '初始发牌';
  const name = profiles[action.seat].name;
  return action.action === 'call' ? name + (action.score ? ' · 叫 ' + action.score + ' 分' : ' · 不叫')
    : action.action === 'pass' ? name + ' · 不出' : name + ' · ' + (combinationNames[snapshot?.lastPlay?.type ?? ''] ?? '出牌') + ' ' + action.cards.map((card) => card.display).join(' ');
}
export const signedScore = (score: number) => score > 0 ? '+' + score : String(score);
