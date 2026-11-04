import { useEffect, useState } from 'react';
import { defaultChartType, runAvaAnalysis, type AvaAnalysis } from '../domain/ava-analysis.js';
import type { AnalysisDataset } from '../domain/replay-analysis.js';

function pendingAnalysis(dataset: AnalysisDataset): AvaAnalysis {
  return { stats: null, insights: [], errors: [], recommendations: dataset.points.length ? [{ type: defaultChartType(dataset) }] : [] };
}

export function useAvaAnalysis(dataset: AnalysisDataset): AvaAnalysis {
  const [state, setState] = useState<{ dataset: AnalysisDataset; analysis: AvaAnalysis } | null>(null);
  useEffect(() => {
    let active = true;
    runAvaAnalysis(dataset).then((analysis) => {
      if (active) setState({ dataset, analysis });
    }).catch(() => {
      if (active) setState({ dataset, analysis: { ...pendingAnalysis(dataset), errors: ['AVA 分析暂不可用'] } });
    });
    return () => { active = false; };
  }, [dataset]);
  return state?.dataset === dataset ? state.analysis : pendingAnalysis(dataset);
}
