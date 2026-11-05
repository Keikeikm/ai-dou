import type { BluffRoomGrant, BluffRoomView } from '../../shared/bluff.js';
import { requestJson } from './client.js';
import { profileParameter } from './player-profile.js';

const tokenKey = (id: string) => 'ai-dou:bluff:' + id;
function bluffToken(id: string): string {
  const token = sessionStorage.getItem(tokenKey(id));
  if (!token) throw new Error('这个标签页没有你的席位信息，请重新开局。');
  return token;
}
export async function createBluffRoom(apiKey: string): Promise<BluffRoomGrant> {
  sessionStorage.setItem('ai-dou:storage-check', '1');
  sessionStorage.removeItem('ai-dou:storage-check');
  const grant = await requestJson<BluffRoomGrant>('/api/bluff/rooms', { method: 'POST', body: JSON.stringify({ apiKey, ...profileParameter() }) });
  sessionStorage.setItem(tokenKey(grant.room.id), grant.token);
  return grant;
}
export function readBluffRoom(id: string, signal?: AbortSignal) {
  return requestJson<BluffRoomView>('/api/bluff/rooms/' + id, { headers: { Authorization: 'Bearer ' + bluffToken(id) }, signal });
}
export function controlBluffRoom(room: BluffRoomView, input: Record<string, unknown>) {
  return requestJson<BluffRoomView>('/api/bluff/rooms/' + room.id, { method: 'POST', headers: { Authorization: 'Bearer ' + bluffToken(room.id) },
    body: JSON.stringify({ ...input, revision: room.revision, generation: room.generation }) });
}
export async function closeBluffRoom(id: string) {
  await requestJson('/api/bluff/rooms/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + bluffToken(id) }, body: '{}' });
  sessionStorage.removeItem(tokenKey(id));
}
