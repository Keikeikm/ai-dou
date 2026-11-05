import type { PlayerProfile } from '../../shared/game-data.js';

const key = 'ai-dou:player-profile';
export function currentProfile(): Pick<PlayerProfile, 'id' | 'name'> {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (value && typeof value.id === 'string' && typeof value.name === 'string') return value;
  } catch { /* The default identity works even if browser storage is unavailable. */ }
  return { id: 'human_local', name: '我' };
}
export function selectProfile(profile: PlayerProfile) { localStorage.setItem(key, JSON.stringify({ id: profile.id, name: profile.name })); }
export function profileParameter() {
  const profile = currentProfile();
  return profile.id === 'human_local' ? {} : { profileId: profile.id };
}
