import type { DataFilter, DataResponse, PlayerProfile, StoredEpisode } from '../../shared/game-data.js';
import type { GameSnapshot } from '../domain/types.js';
import type { BluffObservation } from '../../shared/bluff.js';
import { requestJson } from './client.js';

export function dataParams(filter: DataFilter): URLSearchParams {
  return new URLSearchParams(Object.entries(filter).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => [key, String(value)]));
}
export function dataOverview(filter: DataFilter, offset: number, signal?: AbortSignal) {
  const params = dataParams(filter); params.set('offset', String(offset)); params.set('limit', '12');
  return requestJson<DataResponse>('/api/data/overview?' + params, { signal });
}
export const createProfile = (name: string) => requestJson<PlayerProfile>('/api/data/profiles', { method: 'POST', body: JSON.stringify({ name }) });
export interface EpisodeDetail { episode: StoredEpisode; snapshots: (GameSnapshot | BluffObservation)[] }
export const readEpisode = (id: string, signal?: AbortSignal) => requestJson<EpisodeDetail>('/api/data/episodes/' + id, { signal });
export function exportUrl(filter: DataFilter, format: 'episodes' | 'transitions') {
  const params = dataParams(filter); params.set('format', format); return '/api/data/export?' + params;
}
