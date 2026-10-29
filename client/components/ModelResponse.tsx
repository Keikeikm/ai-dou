import { actionText, origin, profiles, responseFailure } from '../domain/presentation.js';
import type { GameSnapshot, Room, TurnRecord } from '../domain/types.js';
import { useMemo } from 'react';
import { reportedCache, summarizeCache } from '../domain/model-usage.js';

export function ModelCacheSummary({ turns }: { turns: readonly TurnRecord[] }) {
  const summary = useMemo(() => summarizeCache(turns), [turns]);
  return <section className="model-cache-summary" aria-label="本局模型缓存统计"><strong>本局模型缓存统计</strong>
    <p>已记录 {summary.responses} 个模型响应，其中 {summary.reported} 个有完整有效缓存统计。</p>
    {summary.reported > 0 ? <p>已报告部分：命中 {summary.hit} / 未命中 {summary.miss} tokens · 命中率 {summary.rate === null ? '—' : (summary.rate * 100).toFixed(1) + '%'}</p>
      : <p>尚无完整缓存统计，不将缺失值当作零命中。</p>}
    <small>按已返回响应统计，包含未采纳回复；超时、取消或旧记录可能缺失，不等于供应商账单。</small>
  </section>;
}

export function SourceBadge({ turn, room }: { turn?: TurnRecord; room?: Room }) {
  const source = origin(turn, room);
  return <span className={'source-badge source-' + source.kind} title={source.text}>{source.text}</span>;
}

export function ModelResponsePanel({ turn, snapshot, room, expanded = false }: { turn?: TurnRecord; snapshot?: GameSnapshot; room?: Room; expanded?: boolean }) {
  const response = turn?.modelResponse;
  const failed = turn?.source === 'fallback' && (turn.decisionKind === 'model' || room?.players.find((player) => player.seat === turn.seat)?.kind === 'deepseek');
  const cache = reportedCache(response?.usage);
  const meta = response ? [profiles[turn!.seat].name, response.model, response.durationMs + ' ms',
    response.requestId ? 'ID: ' + response.requestId : '', response.finishReason ? 'finish_reason: ' + response.finishReason : ''].filter(Boolean).join(' · ') : '';
  return <details className="model-response-panel" open={failed || expanded} key={turn?.sequence ?? 0}>
    <summary>DeepSeek 回复 · 当前步</summary>
    {failed && <p className="diagnostic-error" role="alert">{responseFailure(response, turn?.reason)}</p>}
    <p>{!turn ? '初始发牌尚未调用模型；选择历史步骤查看回复' : response ? meta : turn.decisionKind === 'model'
      ? '本步未记录回复正文，旧局无法补查' : turn.decisionKind === 'human' ? '本步由真人操作，没有 DeepSeek 回复' : '本步由 Bot / HTTP Agent 执行，没有 DeepSeek 回复'}</p>
    {response?.usage && <p>Tokens：输入 {response.usage.promptTokens ?? '—'} / 输出 {response.usage.completionTokens ?? '—'} / 总计 {response.usage.totalTokens ?? '—'}</p>}
    {response?.strategy && <p>策略 skill：{response.strategy.name} v{response.strategy.version} · 指纹 {response.strategy.digest.slice(0, 12)}</p>}
    {response && <p>上下文缓存：命中 {response.usage?.cacheHitTokens ?? '未报告'} / 未命中 {response.usage?.cacheMissTokens ?? '未报告'} tokens · 命中率 {cache?.rate == null ? '未提供有效比例' : (cache.rate * 100).toFixed(1) + '%'}</p>}
    {response && <><p>{response.status === 'accepted' ? '回复已采纳' : '回复未采纳，实际执行系统托管动作'}</p>
      <pre>{response.content ?? '未收到可展示的回复正文'}</pre>
      <p>{response.actionIndex !== undefined && <>action_index {response.actionIndex} → </>}实际执行：{actionText(snapshot)}{response.contentTruncated && ' · 正文已截断'}</p></>}
  </details>;
}
