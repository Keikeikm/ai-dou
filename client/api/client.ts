import type { AgentRegistration, DeepSeekCheckResult, GameRecord, GameSummary, GameSnapshot, ProviderConfig, Replay, Room } from '../domain/types.js';
import type { HumanControlGrant, HumanSubmission } from '../../shared/human-player.js';
import { saveHumanControl } from '../domain/human-control.js';
import type { AnalysisChatConfig, AnalysisChatReply, AnalysisChatRequest } from '../../shared/replay-chat.js';

export async function requestJson<Result>(path: string, options: RequestInit = {}): Promise<Result> {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    if (path === '/api/config' && response.status === 404) throw new Error('旧版后端不支持当前棋牌室，请重启 npm run ui');
    throw new Error(response.status === 404 ? '房间或资源不存在；服务重启后请回首页创建新房' : error.error ?? '请求失败，请稍后重试');
  }
  return response.json();
}

export async function configuration(signal?: AbortSignal) {
  const result = await requestJson<{ baseScore: number; capabilities?: { randomDeals: boolean; modelResponses: boolean; humanPlayers?: boolean } }>('/api/config', { signal });
  if (!result.capabilities?.randomDeals || !result.capabilities.modelResponses) throw new Error('旧版后端未启用随机发牌或回复记录，请重启 npm run ui');
  return result;
}

export const providerConfiguration = (signal?: AbortSignal) => requestJson<ProviderConfig>('/api/providers/deepseek', { signal });
export const roomReplay = (id: string, signal?: AbortSignal) => requestJson<Replay>('/api/rooms/' + id + '/replay', { signal });
export const archiveReplay = (id: string, signal?: AbortSignal) => requestJson<GameRecord & { snapshots: GameSnapshot[] }>('/api/games/' + id + '/replay', { signal });
export const roomControl = (id: string, action: string, signal?: AbortSignal) => requestJson<Replay>('/api/rooms/' + id + '/control', { method: 'POST', body: JSON.stringify({ action }), signal });
export async function createRoom(players: AgentRegistration[], baseScore: number) {
  const config = await configuration();
  if (players.some((player) => player.kind === 'human') && !config.capabilities?.humanPlayers) throw new Error('旧版后端不支持真人对战，请重启 npm run ui');
  const room = await requestJson<Room & { humanControl?: HumanControlGrant }>('/api/rooms', { method: 'POST', body: JSON.stringify({ players, baseScore }) });
  if (room.humanControl) saveHumanControl(room.id, room.humanControl);
  return room;
}
export async function joinAgent(id: string, registration: AgentRegistration) {
  const room = await requestJson<Room & { humanControl?: HumanControlGrant }>('/api/rooms/' + id + '/players', { method: 'POST', body: JSON.stringify(registration) });
  if (room.humanControl) saveHumanControl(id, room.humanControl);
  return room;
}
export const submitHumanAction = (id: string, token: string, submission: HumanSubmission, signal?: AbortSignal) => requestJson<Replay>('/api/rooms/' + id + '/human-action', {
  method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: JSON.stringify(submission), signal,
});
export const updateKey = (roomId: string, playerId: string, apiKey: string | null) => requestJson<Room>('/api/rooms/' + roomId + '/players/' + playerId + '/api-key', { method: 'PUT', body: JSON.stringify({ api_key: apiKey }) });
export const checkAgent = (roomId: string, playerId: string, signal?: AbortSignal) => requestJson<DeepSeekCheckResult>('/api/rooms/' + roomId + '/players/' + playerId + '/check', { method: 'POST', body: JSON.stringify({ confirm: true }), signal });
export const roomGames = (id: string) => requestJson<{ games: GameSummary[] }>('/api/rooms/' + id + '/games?limit=20');
export const analysisConfiguration = (signal?: AbortSignal) => requestJson<AnalysisChatConfig>('/api/analysis/config', { signal });
export const askReplayAnalysis = (kind: 'room' | 'archive', id: string, question: AnalysisChatRequest, signal?: AbortSignal) =>
  requestJson<AnalysisChatReply>('/api/' + (kind === 'archive' ? 'games' : 'rooms') + '/' + id + '/analysis', { method: 'POST', body: JSON.stringify(question), signal });
