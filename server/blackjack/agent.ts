import type { BlackjackAction, BlackjackObservation } from '../../shared/blackjack.js';
import { DEEPSEEK_API_URL, type DeepSeekCompletionRequest, type DeepSeekOptions } from '../agents/deepseek.js';
import { AgentEndpointPolicy, requestAgentJson } from '../agents/http.js';

const instructions = `你是 DeepSeek 鲸鱼娘，与人类进行双人 21 点自由对决。你是 seat=1，不是按固定阈值补牌的庄家。
一副52张牌，无大小王。每人起手2张。A按1或11自动取不爆牌的最高点数，J/Q/K各10点。双方起手21点为平局，只有一方起手21点则立即获胜。
人类先行动，此后双方轮流选择要牌(hit)或停牌(stand)。停牌后不能再要牌；对方已停牌时可以连续行动。达到21点自动停牌。任意一方先爆牌(超过21点)立即输；双方停牌后点数高者胜，同点平局。
目标是在不爆牌的前提下战胜对手。你可以自由决定要牌或停牌，没有庄家17点必须停牌的限制。根据自己的手牌、对方公开首牌、牌数、停牌状态和行动历史作决定。
输入只包含你的hand及公开信息，opponent中的null代表不可见的暗牌；不能假设知道对方暗牌或牌堆。handValue给出正确点数。stood按座位0、1排列，winner也是绝对座位。result是相对人类的结果。
只输出一个JSON对象：{"type":"hit"}或{"type":"stand"}。不要解释、Markdown、台词或其他字段。`;

export interface BlackjackAgent { decide(observation: BlackjackObservation, signal: AbortSignal): Promise<BlackjackAction> }
export function createBlackjackAgent(options: DeepSeekOptions): BlackjackAgent {
  const policy = new AgentEndpointPolicy(['https://api.deepseek.com']);
  const transport = options.transport ?? ((credentials, request, signal) => requestAgentJson(policy, credentials, request, signal, 65536));
  return { async decide(observation, signal) {
    const request: DeepSeekCompletionRequest = { model: options.model ?? 'deepseek-flash', thinking: { type: 'disabled' }, response_format: { type: 'json_object' }, stream: false, max_tokens: 256,
      messages: [{ role: 'system', content: instructions }, { role: 'user', content: JSON.stringify(observation) }] };
    const response = await transport({ apiUrl: DEEPSEEK_API_URL, apiKey: options.apiKey }, request, signal);
    signal.throwIfAborted();
    const value = response as { choices?: { finish_reason?: string; message?: { content?: string } }[] } | null;
    const choice = value?.choices?.length === 1 ? value.choices[0] : undefined;
    if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string' || choice.message.content.length > 4096) throw new Error('invalid_response');
    try { return JSON.parse(choice.message.content) as BlackjackAction; } catch { throw new Error('invalid_response'); }
  } };
}
