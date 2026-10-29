import type { AnalysisReplay as Replay } from './replay-chat.js';
import { combinationNames, origin } from './analysis-support.js';
import { reportedCache } from './analysis-support.js';

export type AnalysisMetric = 'hands' | 'actions' | 'combinations' | 'duration' | 'tokens' | 'cache';
export const metricLabels: Record<AnalysisMetric, string> = {
  hands: '手牌张数变化', actions: '动作分布', combinations: '出牌牌型', duration: '模型决策耗时', tokens: '模型 Token 用量', cache: '提示缓存命中率',
};
export interface AnalysisRow {
  step: number; sequence: number; seat: number; player: string; action: string; source: string;
  cards: number; combination: string; remaining: number | null;
  duration: number | null; tokens: number | null; cache: number | null;
}
export interface AnalysisPoint { x: string | number; y: number; series: string; steps: number[] }
export interface AnalysisDataset {
  metric: AnalysisMetric; points: AnalysisPoint[]; xLabel: string; yLabel: string; categorical: boolean;
  observations: number; missing: number;
}

const nonNegative = (value?: number): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function analysisRows(replay: Replay): AnalysisRow[] {
  return replay.turns.map((turn, index) => {
    const snapshot = replay.snapshots[index + 1];
    const cache = reportedCache(turn.modelResponse?.usage);
    return { step: index + 1, sequence: turn.sequence, seat: turn.seat,
      player: replay.room.players.find((player) => player.seat === turn.seat)?.name ?? snapshot?.players[turn.seat] ?? '席位 ' + (turn.seat + 1),
      action: { call: '叫分', play: '出牌', pass: '不出' }[turn.action.type], source: origin(turn, replay.room).text,
      cards: turn.action.type === 'play' ? turn.action.cards.length : 0,
      combination: turn.action.type === 'play' ? (combinationNames[snapshot?.lastPlay?.type ?? ''] ?? '未知牌型') : '',
      remaining: snapshot?.hands[turn.seat]?.length ?? null,
      duration: nonNegative(turn.modelResponse?.durationMs), tokens: nonNegative(turn.modelResponse?.usage?.totalTokens),
      cache: cache?.rate === null || !cache ? null : cache.rate * 100,
    };
  });
}

export function analysisDataset(replay: Replay, metric: AnalysisMetric, seat: number | 'all', from: number, to: number): AnalysisDataset {
  const categorical = metric === 'actions' || metric === 'combinations';
  const dataset: AnalysisDataset = { metric, points: [], categorical, observations: 0, missing: 0,
    xLabel: categorical ? metric === 'actions' ? '动作' : '牌型' : '历史步骤',
    yLabel: { hands: '张', actions: '次数', combinations: '次数', duration: '毫秒', tokens: 'Token', cache: '%' }[metric] };
  const last = Math.max(0, replay.snapshots.length - 1);
  const start = Math.max(0, Math.min(from, last));
  const end = Math.max(start, Math.min(to, last));
  const playerName = (s: number) => (replay.room.players.find((p) => p.seat === s)?.name ?? replay.snapshots[0]?.players[s] ?? '玩家') + ' · 席位 ' + (s + 1);
  if (metric === 'hands') {
    replay.snapshots.slice(start, end + 1).forEach((snapshot, offset) => {
      snapshot.hands.forEach((hand, s) => {
        if (seat !== 'all' && seat !== s) return;
        dataset.observations += 1;
        dataset.points.push({ x: start + offset, y: hand.length, series: playerName(s), steps: [start + offset] });
      });
    });
    return dataset;
  }
  const grouped = new Map<string, AnalysisPoint>();
  for (const row of analysisRows(replay)) {
    if (row.step < start || row.step > end || (seat !== 'all' && row.seat !== seat)) continue;
    if (metric === 'combinations' && !row.combination) continue;
    // Bot / human turns have no model measurement; they are not missing model reports.
    if (!categorical && !replay.turns[row.step - 1].modelResponse) continue;
    dataset.observations += 1;
    if (categorical) {
      const category = metric === 'actions' ? row.action : row.combination;
      const key = row.seat + ':' + category;
      const point = grouped.get(key) ?? { x: category, y: 0, series: playerName(row.seat), steps: [] };
      point.y += 1; point.steps.push(row.step); grouped.set(key, point);
    } else {
      const value = row[metric];
      if (value === null) { dataset.missing += 1; continue; }
      dataset.points.push({ x: row.step, y: value, series: playerName(row.seat), steps: [row.step] });
    }
  }
  if (categorical) dataset.points = [...grouped.values()];
  return dataset;
}

export function analysisCsv(rows: AnalysisRow[]): string {
  const columns: (keyof AnalysisRow)[] = ['step', 'sequence', 'seat', 'player', 'action', 'source', 'cards', 'combination', 'remaining', 'duration', 'tokens', 'cache'];
  const labels = ['历史步骤', '决策序号', '席位（0起）', '玩家', '动作', '来源', '出牌张数', '牌型', '剩余手牌', '模型耗时(ms)', '总Token', '缓存命中率(%)'];
  const cell = (value: unknown) => {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + [labels, ...rows.map((row) => columns.map((column) => row[column]))].map((row) => row.map(cell).join(',')).join('\r\n');
}
