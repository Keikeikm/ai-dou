import { useState } from 'react';
import type { AnalysisDataset, AnalysisPoint } from '../domain/replay-analysis.js';
import type { AnalysisChartType } from '../domain/ava-analysis.js';

const colors = ['#7758a6', '#b87720', '#267c96'];
export function AnalysisChart({ dataset, type, seek }: { dataset: AnalysisDataset; type: AnalysisChartType; seek: (step: number) => void }) {
  const [active, setActive] = useState<AnalysisPoint | null>(null);
  const series = [...new Set(dataset.points.map((point) => point.series))];
  const categories = [...new Set(dataset.points.map((point) => String(point.x)))];
  const bars = type === 'column_chart' || type === 'grouped_column_chart';
  const categoryAxis = dataset.categorical || bars;
  const left = 64, top = 28, width = 716, height = 244;
  const maxY = Math.max(1, ...dataset.points.map((point) => point.y));
  const minX = Math.min(...dataset.points.map((point) => Number(point.x)));
  const maxX = Math.max(...dataset.points.map((point) => Number(point.x)));
  const x = (point: AnalysisPoint) => categoryAxis ? left + (categories.indexOf(String(point.x)) + 0.5) * width / categories.length
    : left + (Number(point.x) - minX) / Math.max(1, maxX - minX) * width;
  const y = (value: number) => top + height - value / maxY * height;
  const select = (point: AnalysisPoint) => { setActive(point); };
  return <div className="analysis-plot">
    <div className="analysis-legend">{series.map((name, index) => <span key={name}><i style={{ background: colors[index % colors.length] }} />{name}</span>)}</div>
    <svg viewBox="0 0 820 335" role="img" aria-label={`${dataset.xLabel}与${dataset.yLabel}分析图`}>
      <title>{dataset.xLabel}与{dataset.yLabel}分析图，选择数据点查看数值并跳转历史</title>
      {[0, 1, 2, 3, 4].map((tick) => <g key={tick}><line x1={left} x2={left + width} y1={y(maxY * tick / 4)} y2={y(maxY * tick / 4)} stroke="#dce2d3" />
        <text x={left - 10} y={y(maxY * tick / 4) + 4} textAnchor="end">{Number((maxY * tick / 4).toFixed(1))}</text></g>)}
      <text x={left} y={16}>{dataset.yLabel}</text><text x={left + width} y={326} textAnchor="end">{dataset.xLabel}</text>
      {categoryAxis ? categories.filter((_, i) => i % Math.max(1, Math.ceil(categories.length / 10)) === 0 || i === categories.length - 1).map((category) => <text key={category} x={left + (categories.indexOf(category) + 0.5) * width / categories.length} y={top + height + 23} textAnchor="middle">{category}</text>)
        : [...new Set([minX, Math.round((minX + maxX) / 2), maxX])].map((tick) => <text key={tick} x={left + (tick - minX) / Math.max(1, maxX - minX) * width} y={top + height + 23} textAnchor="middle">{tick}</text>)}
      {type === 'line_chart' && series.map((name, index) => <polyline key={name} fill="none" stroke={colors[index % colors.length]} strokeWidth="2.5"
        points={dataset.points.filter((point) => point.series === name).map((point) => x(point) + ',' + y(point.y)).join(' ')} />)}
      {dataset.points.map((point, index) => {
        const color = colors[series.indexOf(point.series) % colors.length];
        const title = `${point.series} · ${dataset.categorical ? point.x : '第 ' + point.x + ' 步'} · ${Number(point.y.toFixed(2))} ${dataset.yLabel}`;
        const common = { role: 'button', tabIndex: 0, 'aria-label': title, onClick: () => select(point),
          onKeyDown: (event: React.KeyboardEvent<SVGElement>) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(point); } } };
        if (bars) {
          const barWidth = Math.min(46, width / categories.length / (series.length + 1));
          return <rect key={index} {...common} x={x(point) + (series.indexOf(point.series) - series.length / 2) * barWidth} y={y(point.y)}
            width={Math.max(0.5, barWidth * 0.85)} height={top + height - y(point.y)} rx="3" fill={color}><title>{title}</title></rect>;
        }
        return <circle key={index} {...common} cx={x(point)} cy={y(point.y)} r={type === 'scatter_plot' ? 5 : 4} fill={color} stroke="#fff" strokeWidth="1"><title>{title}</title></circle>;
      })}
    </svg>
    <p className="analysis-point-detail" role="status">{active ? <>{active.series} · {dataset.categorical ? active.x : '第 ' + active.x + ' 步'} · {Number(active.y.toFixed(2))} {dataset.yLabel}
      <button onClick={() => seek(active.steps[0])}>回看第 {active.steps[0]} 步</button>{active.steps.length > 1 && <small>该类别共关联 {active.steps.length} 步，下面的数据表可逐步回看。</small>}</> : '点击图中的数据点或柱形查看数值，支持键盘 Enter。'}</p>
  </div>;
}
