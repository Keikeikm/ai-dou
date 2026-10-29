import type { GameSnapshot } from '../server/game/snapshots.js';
import type { TurnRecord } from '../server/rooms/scheduler.js';

export interface AnalysisReplay {
  generation: number;
  snapshots: readonly GameSnapshot[];
  turns: readonly TurnRecord[];
  room: { id: string; players: readonly { seat: number; name: string; kind: string }[] };
}
export interface AnalysisScope { generation: number; from: number; to: number; seat: number | 'all'; metric: 'hands' | 'actions' | 'combinations' | 'duration' | 'tokens' | 'cache' }
export interface AnalysisChatMessage { role: 'user' | 'assistant'; content: string }
export interface AnalysisChatRequest { question: string; scope: AnalysisScope; history: AnalysisChatMessage[] }
export interface AnalysisChatReply {
  answer: string;
  steps: number[];
  chart: { metric: AnalysisScope['metric']; seat: number | 'all'; type?: import('./ava-analysis.js').AnalysisChartType } | null;
  scope: AnalysisScope;
  model: string;
  usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null };
  context: { rows: number; includedRows: number; sampled: boolean };
}
export interface AnalysisChatConfig { enabled: boolean; model: string }
