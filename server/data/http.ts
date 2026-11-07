import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { DataFilter } from '../../shared/game-data.js';
import { RoomError } from '../rooms/room-manager.js';
import { DataStore } from './store.js';
import { episodeSnapshots, trainingTransitions } from './episodes.js';

export function dataFilter(url: URL): DataFilter {
  const filter: DataFilter = {};
  const game = url.searchParams.get('game'); const status = url.searchParams.get('status'); const profileId = url.searchParams.get('profileId');
  if (game) { if (game !== 'bluff' && game !== 'doudizhu' && game !== 'blackjack') throw new RoomError(400, '无效游戏类型'); filter.game = game; }
  if (status) { if (!['finished', 'abandoned', 'interrupted'].includes(status)) throw new RoomError(400, '无效对局状态'); filter.status = status as NonNullable<DataFilter['status']>; }
  if (profileId) { if (!/^[a-zA-Z0-9_-]{1,512}$/.test(profileId)) throw new RoomError(400, '无效玩家档案'); filter.profileId = profileId; }
  for (const key of ['from', 'to'] as const) {
    const value = url.searchParams.get(key);
    if (value !== null) { const number = Number(value); if (!value || !Number.isSafeInteger(number) || number < 0 || number > 8640000000000000) throw new RoomError(400, '无效日期范围'); filter[key] = number; }
  }
  if (filter.from !== undefined && filter.to !== undefined && filter.from > filter.to) throw new RoomError(400, '开始日期不能晚于结束日期');
  return filter;
}
export async function handleDataRequest(store: DataStore, url: URL, request: IncomingMessage, response: ServerResponse,
  readBody: (request: IncomingMessage) => Promise<Record<string, unknown>>): Promise<boolean> {
  if (!url.pathname.startsWith('/api/data/')) return false;
  const host = request.headers.host ?? '';
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || request.headers.origin && request.headers.origin !== 'http://' + host) throw new RoomError(403, '数据中心仅限本机同源访问');
  const read = request.method === 'GET' || request.method === 'HEAD';
  const json = (value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(request.method === 'HEAD' ? undefined : JSON.stringify(value)); };
  if (url.pathname === '/api/data/profiles') {
    if (read) json(store.profiles());
    else if (request.method === 'POST') { const body = await readBody(request); try { json(store.createProfile(body.name), 201); } catch (error) { throw new RoomError(400, (error as Error).message); } }
    else throw new RoomError(405, 'Method not allowed');
    return true;
  }
  if (!read) throw new RoomError(405, 'Method not allowed');
  if (url.pathname === '/api/data/overview') {
    const limit = Number(url.searchParams.get('limit') ?? 20); const offset = Number(url.searchParams.get('offset') ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 1000000) throw new RoomError(400, '无效分页');
    json(store.query(dataFilter(url), limit, offset)); return true;
  }
  if (url.pathname === '/api/data/export') {
    const filter = dataFilter(url);
    const format = url.searchParams.get('format') ?? 'episodes';
    if (format !== 'episodes' && format !== 'transitions') throw new RoomError(400, '无效导出格式');
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': 'attachment; filename="ai-dou-' + format + '-v1.jsonl"' });
    if (request.method !== 'HEAD') for (const episode of store.episodes(filter)) {
      if (response.destroyed) break;
      const records = format === 'episodes' ? [episode] : trainingTransitions(episode, filter.profileId);
      for (const record of records) {
        if (response.destroyed) break;
        if (!response.write(JSON.stringify(record) + '\n')) {
          try { await once(response, 'drain', { signal: AbortSignal.timeout(30000) }); } catch { response.destroy(); break; }
        }
      }
    }
    response.end(); return true;
  }
  const match = url.pathname.match(/^\/api\/data\/episodes\/([a-zA-Z0-9_-]{1,100})$/);
  if (match) {
    const episode = store.get(match[1]);
    if (!episode) throw new RoomError(404, '找不到已归档的对局；进行中的隐藏信息不开放');
    json({ episode, snapshots: episodeSnapshots(episode) }); return true;
  }
  throw new RoomError(404, 'Not found');
}
