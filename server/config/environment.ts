import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateDeepSeekModel } from '../agents/deepseek.js';
import type { RoomManagerOptions } from '../rooms/room-manager.js';

export function loadReplayEnvironment(directory = process.cwd()): void {
  for (const filename of ['.env.local', '.env']) {
    const path = resolve(directory, filename);
    if (existsSync(path)) process.loadEnvFile(path);
  }
}

export function serverConfiguration(): RoomManagerOptions {
  return {
    turnTimeoutMs: Number(process.env.TURN_TIMEOUT_MS ?? 1500),
    stepIntervalMs: Number(process.env.STEP_INTERVAL_MS ?? 950),
    idleTimeoutMs: Number(process.env.ROOM_IDLE_TIMEOUT_MS ?? 1800000),
    closedRetentionMs: Number(process.env.ROOM_CLOSED_RETENTION_MS ?? 300000),
    agentAllowedOrigins: (process.env.AGENT_ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
    baseScore: Number(process.env.BASE_SCORE ?? 1),
    scoreDatabasePath: process.env.SCORE_DB_PATH ?? resolve('data/ai-dou.sqlite'),
    deepseek: { apiKey: process.env.DEEPSEEK_API_KEY || undefined, model: validateDeepSeekModel(process.env.DEEPSEEK_MODEL ?? 'deepseek-flash') },
    deepseekTurnTimeoutMs: Number(process.env.DEEPSEEK_TURN_TIMEOUT_MS ?? 15000),
  };
}
