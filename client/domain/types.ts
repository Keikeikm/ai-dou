import type { Card } from '../../server/game/cards.js';
import type { GameSnapshot } from '../../server/game/snapshots.js';
import type { DecisionProgress, ModelResponse, TurnRecord } from '../../server/rooms/scheduler.js';
import type { AgentRegistration, RoomStatus } from '../../server/rooms/room-manager.js';
import type { GameRecord, GameSummary, ScoreEntry } from '../../server/storage/score-store.js';
import type { DeepSeekCheckResult } from '../../server/agents/deepseek.js';
import type { SkillId } from '../../shared/strategy-skills.js';

export type { Card, GameSnapshot, ModelResponse, TurnRecord, AgentRegistration, GameRecord, GameSummary, ScoreEntry, DeepSeekCheckResult };

export interface Player {
  id: string;
  name: string;
  seat: number;
  kind: string;
  score: number;
  model?: string;
  hasApiKey?: boolean;
  keySource?: string;
  skill?: SkillId;
}

export interface Room {
  id: string;
  name: string;
  status: RoomStatus;
  players: Player[];
  spectators: number;
  generation: number;
  baseScore: number;
  viewUrl: string;
}

export interface Session {
  status: string;
  turnTimeoutMs: number;
  stepIntervalMs: number;
  serverTime?: number;
  decision?: DecisionProgress | null;
}

export interface Replay {
  room: Room;
  generation: number;
  revision: number;
  snapshots: GameSnapshot[];
  turns: TurnRecord[];
  session: Session;
  accounting?: { status: 'recorded' | 'error'; gameId: string; entries: ScoreEntry[] } | null;
}

export type LiveUpdate = Omit<Replay, 'snapshots' | 'turns'> & {
  snapshots?: GameSnapshot[];
  turns?: TurnRecord[];
  index?: number;
  snapshot?: GameSnapshot;
  turn?: TurnRecord;
};

export interface ProviderConfig {
  model: string;
  hasServerKey: boolean;
  turnTimeoutMs: number;
}

export type Route = { kind: 'home' } | { kind: 'room'; id: string } | { kind: 'archive'; id: string };

export function parseRoute(pathname: string): Route {
  const room = pathname.match(/^\/rooms\/(room_[a-f0-9]{12})\/?$/);
  if (room) return { kind: 'room', id: room[1] };
  const archive = pathname.match(/^\/games\/(game_[a-f0-9]{12}_[1-9][0-9]*)\/?$/);
  return archive ? { kind: 'archive', id: archive[1] } : { kind: 'home' };
}
