import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AvaVisualization } from '../../shared/ava-charts.js';
import { buildAvaChart, type AvaChartType, type ChartSelection } from '../../shared/ava-charts.js';
import type { AnalysisReplay, AnalysisScope } from '../../shared/replay-chat.js';

export function ReplayAvaChart({ replay, scope, selection, type }: { replay: AnalysisReplay; scope: AnalysisScope; selection: ChartSelection; type: AvaChartType }) {
  const view = useMemo(() => {
    try { return { visualization: buildAvaChart(replay, scope, selection, type), error: '' }; }
    catch (error) { return { visualization: null, error: error instanceof Error ? error.message : '无法生成图表。' }; }
  }, [replay, scope.generation, scope.from, scope.to, selection.metric, selection.seat, selection.xMetric, selection.yMetric, type]);
  return view.visualization ? <AvaChart visualization={view.visualization} /> : <p role="status">{view.error}</p>;
}

export function AvaChart({ visualization }: { visualization: AvaVisualization }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const channel = useId();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const serialized = JSON.stringify(visualization.config).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const runtime = new URL('/chart-runtime/gpt-vis.js', window.location.href);
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${runtime.origin} 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data: blob:; font-src 'none'; base-uri 'none'; form-action 'none'">
<style>html,body{margin:0;background:#fffef8;font-family:Arial,sans-serif}#container{width:100%;height:400px}body{overflow:auto}</style>
</head><body><div id="container"></div><script src="${runtime.href}"></script><script>
const notify=(type)=>parent.postMessage({type,channel:${JSON.stringify(channel)}},'*');
let failed=false;
const fail=()=>{failed=true;document.getElementById('container').textContent='图表渲染失败，请调整图表类型或数据范围。';notify('ava-chart-error');};
window.addEventListener('error',fail);
window.addEventListener('unhandledrejection',fail);
(async()=>{try{const vis=new GPTVis.GPTVis({container:'#container'});await vis.render(${serialized});if(!failed)notify('ava-chart-ready');}catch{fail();}})();
</script></body></html>`;
  useEffect(() => {
    setStatus('loading');
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.channel !== channel) return;
      if (event.data.type === 'ava-chart-ready') setStatus('ready');
      if (event.data.type === 'ava-chart-error') setStatus('error');
    };
    window.addEventListener('message', listener);
    const timer = setTimeout(() => setStatus((previous) => previous === 'loading' ? 'error' : previous), 15000);
    return () => { window.removeEventListener('message', listener); clearTimeout(timer); };
  }, [channel, srcDoc]);
  return <div className="ava-chart">
    {status === 'loading' && <p role="status">正在绘制 AVA 图表…</p>}
    {status === 'error' && <p role="alert">图表未能完成渲染，请检查本地图表资源或调整图表类型；可查看下方原始数据。</p>}
    <iframe ref={frame} title={`AVA ${visualization.chartType} 图表`} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc} />
    <details className="analysis-data"><summary>查看图表数据</summary><pre>{JSON.stringify(visualization.config, null, 2)}</pre></details>
  </div>;
}
