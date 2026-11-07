import type { BlackjackRoomGrant, BlackjackRoomView } from '../../shared/blackjack.js';
import { requestJson } from './client.js';
import { profileParameter } from './player-profile.js';

const tokenKey = (id: string) => 'ai-dou:blackjack:' + id;
const openingKey = (room: BlackjackRoomView) => tokenKey(room.id) + ':opening:' + room.generation;
/** Consume once: a newly dealt natural deserves a reveal, a refresh is a result view. */
export function consumeBlackjackOpeningReveal(room: BlackjackRoomView): boolean {
  try {
    const unseen = sessionStorage.getItem(openingKey(room)) === '1';
    sessionStorage.removeItem(openingKey(room));
    return unseen;
  } catch { return false; }
}
function token(id: string) {
  const value = sessionStorage.getItem(tokenKey(id));
  if (!value) throw new Error('这个标签页没有你的席位信息，请重新开局。');
  return value;
}
export async function createBlackjackRoom(apiKey: string): Promise<BlackjackRoomGrant> {
  sessionStorage.setItem('ai-dou:storage-check', '1');
  sessionStorage.removeItem('ai-dou:storage-check');
  const grant = await requestJson<BlackjackRoomGrant>('/api/blackjack/rooms', { method: 'POST', body: JSON.stringify({ apiKey, ...profileParameter() }) });
  sessionStorage.setItem(tokenKey(grant.room.id), grant.token);
  if (grant.room.phase === 'finished') sessionStorage.setItem(openingKey(grant.room), '1');
  return grant;
}
export function readBlackjackRoom(id: string, signal?: AbortSignal) {
  return requestJson<BlackjackRoomView>('/api/blackjack/rooms/' + id, { headers: { Authorization: 'Bearer ' + token(id) }, signal });
}
export function controlBlackjackRoom(room: BlackjackRoomView, input: Record<string, unknown>) {
  return requestJson<BlackjackRoomView>('/api/blackjack/rooms/' + room.id, { method: 'POST', headers: { Authorization: 'Bearer ' + token(room.id) }, body: JSON.stringify({ ...input, revision: room.revision, generation: room.generation }) });
}
export async function closeBlackjackRoom(id: string) {
  await requestJson('/api/blackjack/rooms/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token(id) }, body: '{}' });
  sessionStorage.removeItem(tokenKey(id));
}
