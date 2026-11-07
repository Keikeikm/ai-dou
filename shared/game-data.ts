import type { Card } from '../server/game/cards.js';
import type { GameJournal } from '../server/rooms/scheduler.js';
import type { BlackjackAction, BlackjackSeat } from './blackjack.js';
import type { BluffAction, BluffSeat, BluffRulesVersion } from './bluff.js';

export type GameKind = 'doudizhu' | 'bluff' | 'blackjack';
export type EpisodeStatus = 'active' | 'finished' | 'abandoned' | 'interrupted';
export interface PlayerProfile { id: string; name: string; createdAt: number }
export interface DataPlayer { profileId: string; name: string; seat: number; kind: string; model?: string; strategy?: string; identity: 'profile' | 'agent' | 'legacy' }
export interface BluffStep { seat: BluffSeat; action: BluffAction; at: number; durationMs: number; source: 'human' | 'model' }
export interface BlackjackStep { seat: BlackjackSeat; action: BlackjackAction; at: number; durationMs: number; source: 'human' | 'model' }
export type EpisodeRaw = { game: 'doudizhu'; journal: GameJournal } | { game: 'bluff'; rulesVersion?: BluffRulesVersion; initialHands: [Card[], Card[]]; steps: BluffStep[] } | { game: 'blackjack'; rulesVersion: string; deck: Card[]; steps: BlackjackStep[] };
export interface PlayerMetrics {
  actions: number; plays: number; cardsPlayed: number; passes: number; bids: number; bidTotal: number; bombs: number;
  responses: number; challenges: number; challengesWon: number; bluffs: number; fallbacks: number;
  modelMs: number; modelSamples: number; tokens: number; tokenSamples: number;
  distribution: Record<string, number>;
}
export interface EpisodePlayer extends DataPlayer { metrics: PlayerMetrics; won: boolean | null; outcome?: 'win' | 'loss' | 'push'; role: string }
export interface EpisodeSummary {
  id: string; roomId: string; generation: number; game: GameKind; rulesVersion: string; schemaVersion: 1;
  status: EpisodeStatus; startedAt: number; updatedAt: number; finishedAt: number | null; steps: number;
  players: EpisodePlayer[]; imported: boolean;
}
export interface StoredEpisode extends EpisodeSummary { raw: EpisodeRaw }
export interface DataFilter { game?: GameKind; profileId?: string; from?: number; to?: number; status?: Exclude<EpisodeStatus, 'active'> }
export interface PlayerAggregate { profileId: string; name: string; kind: string; games: number; wins: number; draws?: number; completed: number; metrics: PlayerMetrics; roles: Record<string, { games: number; wins: number }> }
export interface DataOverview {
  total: number; finished: number; incomplete: number; steps: number; humanSteps: number; fallbackSteps: number;
  players: PlayerAggregate[]; trend: { day: string; games: number; completed: number; wins: number; actions: number }[];
  distribution: Record<string, number>; gameCounts: Record<GameKind, number>;
}
export interface DataResponse { overview: DataOverview; games: EpisodeSummary[]; total: number; limit: number; offset: number; active: number; profiles: PlayerProfile[]; storage: { persistent: boolean; schemaVersion: 1 } }
export const gameLabels = { doudizhu: '斗地主', bluff: '吹牛', blackjack: '21 点' };
export const statusLabels = { active: '进行中', finished: '已完成', abandoned: '主动结束', interrupted: '中断' };
export function emptyMetrics(): PlayerMetrics { return { actions: 0, plays: 0, cardsPlayed: 0, passes: 0, bids: 0, bidTotal: 0, bombs: 0, responses: 0, challenges: 0, challengesWon: 0, bluffs: 0, fallbacks: 0, modelMs: 0, modelSamples: 0, tokens: 0, tokenSamples: 0, distribution: {} }; }
