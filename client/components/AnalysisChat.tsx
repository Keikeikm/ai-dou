import { useEffect, useId, useRef, useState } from 'react';
import { analysisConfiguration, askReplayAnalysis } from '../api/client.js';
import type { AnalysisChatConfig, AnalysisChatReply, AnalysisScope, AnalysisReplay } from '../../shared/replay-chat.js';
import { metricLabels } from '../domain/replay-analysis.js';
import { AnalysisReplyChart } from './AnalysisReplyChart.js';

interface Exchange { question: string; scope: AnalysisScope; reply: AnalysisChatReply | null; failed: boolean }

function AnswerText({ answer }: { answer: string }) {
  const [expanded, setExpanded] = useState(true);
  const textId = useId();
  return <>
    <div className="analysis-answer-heading"><strong>复盘助手</strong>
      <button type="button" className="quiet" aria-expanded={expanded} aria-controls={textId} onClick={() => setExpanded((value) => !value)}>
        {expanded ? '折叠文字' : '展开文字'}
      </button>
    </div>
    <p id={textId} hidden={!expanded}>{answer}</p>
  </>;
}

export function AnalysisChat({ source, scope, seek, showChart, replay }: {
  source: { kind: 'room' | 'archive'; id: string }; scope: AnalysisScope; seek: (step: number) => void;
  showChart: (chart: NonNullable<AnalysisChatReply['chart']>, scope: AnalysisScope) => void;
  replay?: AnalysisReplay;
}) {
  const [config, setConfig] = useState<AnalysisChatConfig | null>(null);
  const [question, setQuestion] = useState('');
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const conversation = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (conversation.current) conversation.current.scrollTop = conversation.current.scrollHeight;
  }, [exchanges, busy]);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void analysisConfiguration(controller.signal).then((value) => { if (!controller.signal.aborted) setConfig(value); })
      .catch(() => { if (!controller.signal.aborted) setError('当前后端尚未提供复盘对话，更新后端服务后可用。'); });
    return () => { mounted.current = false; controller.abort(); active.current?.abort(); };
  }, [source.kind, source.id]);
  async function send() {
    const text = question.trim();
    if (!text || text.length > 1000 || active.current || !config?.enabled) return;
    const controller = new AbortController(); active.current = controller;
    const capturedScope = { ...scope };
    const history = exchanges.filter((exchange) => exchange.reply && JSON.stringify(exchange.scope) === JSON.stringify(capturedScope))
      .flatMap((exchange) => [{ role: 'user' as const, content: exchange.question.slice(0, 2000) }, { role: 'assistant' as const, content: exchange.reply!.answer.slice(0, 2000) }]).slice(-6);
    setBusy(true); setError(''); setNotice('');
    const entry: Exchange = { question: text, scope: capturedScope, reply: null, failed: false };
    setExchanges((previous) => [...previous, entry]);
    try {
      const reply = await askReplayAnalysis(source.kind, source.id, { question: text, scope: capturedScope, history }, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setExchanges((previous) => previous.map((exchange) => exchange === entry ? { ...exchange, reply } : exchange));
      setQuestion('');
    } catch (failure) {
      if (!mounted.current) return;
      setExchanges((previous) => previous.map((exchange) => exchange === entry ? { ...exchange, failed: true } : exchange));
      if (controller.signal.aborted) setNotice('已取消本次提问。');
      else setError(failure instanceof Error ? failure.message : '复盘回答失败，请重试。');
    } finally {
      if (active.current === controller) active.current = null;
      if (mounted.current) setBusy(false);
    }
  }
  return <section className="analysis-chat" aria-label="复盘对话">
    <div className="analysis-chat-heading"><h3>向数据提问</h3><span>{config?.model ?? 'DeepSeek'}</span></div>
    <p className="analysis-note">用一句话分析这局牌，也可以直接说“画一张图”。AVA V4 支持 19 类图表，可询问占比、分布、相关性与流向。发送问题会将当前筛选统计、问题和对话历史交给 DeepSeek；生成图表通常额外调用两次模型，可能产生 API 费用。文字可独立折叠。</p>
    {config && !config.enabled && <p role="status">请配置服务端 DEEPSEEK_API_KEY 后使用复盘对话。真人与 Bot 对局也可提问。</p>}
    <div ref={conversation} className="analysis-conversation" role="log" aria-label="复盘对话消息" aria-live="polite" aria-busy={busy}>
      {exchanges.map((exchange, i) => <article className="analysis-exchange" key={i}>
        <div className="analysis-question"><strong>你</strong><p>{exchange.question}</p></div>
        <small>依据第 {exchange.scope.generation} 局 · {exchange.scope.from}–{exchange.scope.to} 步 · {metricLabels[exchange.scope.metric]}</small>
        {exchange.reply ? <div className="analysis-answer"><AnswerText answer={exchange.reply.answer} />
          {exchange.reply.chart && (replay || exchange.reply.chart.visualization) && <AnalysisReplyChart replay={replay} reply={exchange.reply} seek={seek} />}
          <div className="analysis-answer-actions">{exchange.reply.steps.map((step) => <button className="quiet" key={step} onClick={() => seek(step)}>回看第 {step} 步</button>)}
            {exchange.reply.chart && <button onClick={() => showChart(exchange.reply!.chart!, exchange.reply!.scope)}>查看建议图表 · {metricLabels[exchange.reply.chart.metric]}</button>}</div>
          <small>{exchange.reply.usage.totalTokens === null ? '本次用量未记录' : '本次用量 ' + exchange.reply.usage.totalTokens + ' Token'}
            {exchange.reply.context.sampled && ` · 逐步数据抽样 ${exchange.reply.context.includedRows}/${exchange.reply.context.rows}，统计摘要覆盖完整范围`}</small>
        </div> : <p className="analysis-note">{exchange.failed ? '本次未获得回答，问题已保留，可重新发送。' : '正在结合对局数据分析…'}</p>}
      </article>)}
    </div>
    <div className="analysis-suggestions">{['画出三位玩家的手牌张数变化折线图', '用环图展示出牌牌型占比', '用箱线图比较三位玩家的模型耗时', '用散点图分析耗时与 Token 的关系', '用桑基图展示玩家与出牌牌型的流向'].map((text) => <button className="quiet" key={text} disabled={busy} onClick={() => setQuestion(text)}>{text}</button>)}</div>
    <form onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <label htmlFor="analysis-question">复盘问题</label>
      <textarea id="analysis-question" maxLength={1000} rows={3} disabled={busy || !config?.enabled} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：用柱状图比较三位玩家的出牌牌型，并分析有什么特点。" />
      <div className="analysis-chat-controls"><small>当前数据：{scope.from}–{scope.to} 步 · {scope.seat === 'all' ? '全部玩家' : '席位 ' + (scope.seat + 1)}</small>
        <button type="button" disabled={busy || !exchanges.length} onClick={() => { setExchanges([]); setError(''); setNotice(''); }}>清空对话</button>
        {busy ? <button type="button" onClick={() => active.current?.abort()}>取消提问</button> : <button className="primary" type="submit" disabled={!config?.enabled || !question.trim()}>发送提问</button>}</div>
    </form>
    {error && <p className="analysis-chat-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
