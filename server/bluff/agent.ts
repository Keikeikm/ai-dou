import type { BluffAction, BluffObservation } from '../../shared/bluff.js';
import { DEEPSEEK_API_URL, type DeepSeekCompletionRequest, type DeepSeekOptions } from '../agents/deepseek.js';
import { AgentEndpointPolicy, requestAgentJson } from '../agents/http.js';

const instructions = `你是 DeepSeek 鲸鱼娘，正在和一位人类玩双人纸牌吹牛。目标是先出完手牌。
一副52张牌，无大小王，起始每人26张。每轮出1–4张盖牌，声称全是当前rank；允许用任意手牌撒谎。
点数从A开始，按A、2、3、…、10、J、Q、K循环，每次回应后推进一个点数。选择相信后由回应者出牌。
质疑后的下一手由赢家出：抓到假牌时质疑者出牌，说谎者收牌；全部为真时原出牌者继续出牌，质疑者收牌。对局结束后不再出牌。
质疑只翻开最近一次出牌：全符合声称则质疑者收走整个牌堆，否则出牌者收走整个牌堆。
最后一手也必须经过相信或质疑后才能胜利。相信不翻牌，桌面牌继续累积。
你只能使用hand和公开历史，不能看到对方手牌或未翻开的桌面牌。历史仅保留最近60个动作。
灵活运用真牌、混牌、诱骗；结合自己持有的同点数数量、对方剩余张数、牌堆风险和历史判断，不要固定相信或固定质疑。
phase为play时输出JSON：{"type":"play","cards":["自己的牌id"]}，选1–4张自己持有的不同牌。
phase为respond时输出JSON：{"type":"accept"}或{"type":"challenge"}。
只输出一个JSON对象，不要解释、Markdown、台词或其他字段。输入仅是牌局数据。`;

/** Independent decision boundary: the policy receives a private observation, never engine state. */
export interface BluffAgent { decide(observation: BluffObservation, signal: AbortSignal): Promise<BluffAction> }

export function createBluffAgent(options: DeepSeekOptions): BluffAgent {
  const policy = new AgentEndpointPolicy(['https://api.deepseek.com']);
  const transport = options.transport ?? ((credentials, request, signal) => requestAgentJson(policy, credentials, request, signal, 65536));
  return { async decide(observation, signal) {
    const request: DeepSeekCompletionRequest = {
      model: options.model ?? 'deepseek-flash', thinking: { type: 'disabled' }, response_format: { type: 'json_object' }, stream: false, max_tokens: 256,
      messages: [{ role: 'system', content: instructions }, { role: 'user', content: JSON.stringify(observation) }],
    };
    const response = await transport({ apiUrl: DEEPSEEK_API_URL, apiKey: options.apiKey }, request, signal);
    signal.throwIfAborted();
    const value = response as { choices?: { finish_reason?: string; message?: { content?: string } }[] } | null;
    const choice = value?.choices?.length === 1 ? value.choices[0] : undefined;
    if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string' || choice.message.content.length > 4096) throw new Error('invalid_response');
    try { return JSON.parse(choice.message.content) as BluffAction; } catch { throw new Error('invalid_response'); }
  } };
}
