import type { HumanControlGrant } from '../../shared/human-player.js';

export function saveHumanControl(roomId: string, grant: HumanControlGrant): void {
  try { sessionStorage.setItem('ai-dou:human:' + roomId, JSON.stringify(grant)); }
  catch { throw new Error('无法保存真人席位的操控权限，请允许当前页面使用会话存储后重新建房'); }
}

export function readHumanControl(roomId: string): HumanControlGrant | null {
  try {
    const value = JSON.parse(sessionStorage.getItem('ai-dou:human:' + roomId) ?? 'null');
    return value && typeof value.playerId === 'string' && Number.isInteger(value.seat) && value.seat >= 0 && value.seat <= 2
      && typeof value.token === 'string' && /^[a-f0-9]{64}$/.test(value.token) ? value : null;
  } catch { return null; }
}
