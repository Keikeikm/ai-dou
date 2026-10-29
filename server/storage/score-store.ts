import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { replayJournal, type GameJournal } from '../rooms/scheduler.js';
import type { Settlement } from '../game/scoring.js';

export interface ScorePlayer {
  readonly id: string;
  readonly name: string;
  readonly seat: number;
}

export interface ScoreEntry extends ScorePlayer {
  readonly delta: number;
  readonly beforeScore: number;
  readonly afterScore: number;
}

export interface GameRecord {
  readonly gameId: string;
  readonly roomId: string;
  readonly generation: number;
  readonly createdAt: number;
  readonly seed: number;
  readonly settlement: Settlement;
  readonly entries: readonly ScoreEntry[];
  readonly journal: GameJournal & { readonly roomId: string; readonly generation: number; readonly gameId: string };
}

export type GameSummary = Omit<GameRecord, 'journal'>;

export function gameIdFor(roomId: string, generation: number): string {
  if (!/^room_[a-f0-9]{12}$/.test(roomId) || !Number.isSafeInteger(generation) || generation < 1) throw new Error('Invalid game identity');
  return 'game_' + roomId.slice(5) + '_' + generation;
}

export class ScoreStore {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.database = new DatabaseSync(path);
    try {
      this.database.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 3000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, score INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS games (
          id TEXT PRIMARY KEY, room_id TEXT NOT NULL, generation INTEGER NOT NULL,
          created_at INTEGER NOT NULL, seed INTEGER NOT NULL, journal_json TEXT NOT NULL,
          settlement_json TEXT NOT NULL, UNIQUE(room_id, generation)
        );
        CREATE TABLE IF NOT EXISTS score_entries (
          game_id TEXT NOT NULL REFERENCES games(id), player_id TEXT NOT NULL REFERENCES players(id),
          seat INTEGER NOT NULL CHECK(seat BETWEEN 0 AND 2), name TEXT NOT NULL,
          delta INTEGER NOT NULL, before_score INTEGER NOT NULL, after_score INTEGER NOT NULL,
          PRIMARY KEY(game_id, seat), UNIQUE(game_id, player_id)
        );
        CREATE INDEX IF NOT EXISTS games_room ON games(room_id, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS entries_player ON score_entries(player_id, game_id);
      `);
    } catch (error) { this.database.close(); throw error; }
  }

  getScore(playerId: string): number {
    const row = this.database.prepare('SELECT score FROM players WHERE id = ?').get(playerId);
    return row ? Number(row.score) : 0;
  }

  record(roomId: string, generation: number, players: readonly ScorePlayer[], journal: GameJournal, createdAt = Date.now()): GameRecord {
    const gameId = gameIdFor(roomId, generation);
    const ordered = [...players].sort((left, right) => left.seat - right.seat);
    if (ordered.length !== 3 || new Set(ordered.map((player) => player.id)).size !== 3 || ordered.some((player, seat) =>
      player.seat !== seat || !/^[a-zA-Z0-9_-]{1,64}$/.test(player.id) || player.name !== journal.players[seat])) throw new Error('Invalid settlement players');
    if (journal.status !== 'finished' || !Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error('Only completed games can enter the score ledger');
    const settlement = replayJournal(journal).at(-1)?.settlement;
    if (!settlement) throw new Error('Missing verified settlement');
    const archived = { ...journal, roomId, generation, gameId };
    const journalJson = JSON.stringify(archived);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.getGame(gameId);
      if (existing) {
        if (JSON.stringify(existing.journal) !== journalJson || existing.entries.some((entry, seat) => entry.id !== ordered[seat].id)) throw new Error('Conflicting game settlement');
        this.database.exec('COMMIT');
        return existing;
      }
      const entries = ordered.map((player, seat) => {
        const beforeScore = this.getScore(player.id);
        const delta = settlement.players[seat].delta;
        const afterScore = beforeScore + delta;
        if (!Number.isSafeInteger(afterScore)) throw new Error('Player score exceeds safe integer limits');
        return { id: player.id, name: player.name, seat: player.seat, delta, beforeScore, afterScore };
      });
      this.database.prepare('INSERT INTO games VALUES (?, ?, ?, ?, ?, ?, ?)').run(gameId, roomId, generation, createdAt, journal.seed, journalJson, JSON.stringify(settlement));
      for (const entry of entries) {
        this.database.prepare('INSERT INTO players (id, score) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET score = excluded.score').run(entry.id, entry.afterScore);
        this.database.prepare('INSERT INTO score_entries VALUES (?, ?, ?, ?, ?, ?, ?)').run(gameId, entry.id, entry.seat, entry.name, entry.delta, entry.beforeScore, entry.afterScore);
      }
      this.database.exec('COMMIT');
      return { gameId, roomId, generation, createdAt, seed: journal.seed, settlement, entries, journal: archived };
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  getGame(gameId: string): GameRecord | undefined {
    const row = this.database.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    if (!row) return undefined;
    return { ...this.summary(row), journal: JSON.parse(String(row.journal_json)) as GameRecord['journal'] };
  }

  listRoomGames(roomId: string, limit = 20, offset = 0) {
    this.validatePage(limit, offset);
    const rows = this.database.prepare('SELECT id, room_id, generation, created_at, seed, settlement_json FROM games WHERE room_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?').all(roomId, limit, offset);
    const total = Number(this.database.prepare('SELECT count(*) AS total FROM games WHERE room_id = ?').get(roomId)!.total);
    return { total, limit, offset, games: rows.map((row) => this.summary(row)) };
  }

  getPlayerLedger(playerId: string, limit = 20, offset = 0) {
    this.validatePage(limit, offset);
    const rows = this.database.prepare(`SELECT e.*, g.room_id, g.created_at, g.generation FROM score_entries e
      JOIN games g ON g.id = e.game_id WHERE e.player_id = ? ORDER BY g.created_at DESC, g.id DESC LIMIT ? OFFSET ?`).all(playerId, limit, offset);
    const total = Number(this.database.prepare('SELECT count(*) AS total FROM score_entries WHERE player_id = ?').get(playerId)!.total);
    return { id: playerId, score: this.getScore(playerId), total, limit, offset, entries: rows.map((row) => ({ ...this.entry(row),
      gameId: String(row.game_id), roomId: String(row.room_id), generation: Number(row.generation), createdAt: Number(row.created_at) })) };
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private validatePage(limit: number, offset: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 1000000) throw new Error('Invalid record pagination');
  }

  private entry(row: Record<string, unknown>): ScoreEntry {
    return { id: String(row.player_id), name: String(row.name), seat: Number(row.seat), delta: Number(row.delta),
      beforeScore: Number(row.before_score), afterScore: Number(row.after_score) };
  }

  private summary(row: Record<string, unknown>): GameSummary {
    return { gameId: String(row.id), roomId: String(row.room_id), generation: Number(row.generation), createdAt: Number(row.created_at), seed: Number(row.seed),
      settlement: JSON.parse(String(row.settlement_json)) as Settlement,
      entries: this.database.prepare('SELECT * FROM score_entries WHERE game_id = ? ORDER BY seat').all(String(row.id)).map((entry) => this.entry(entry)) };
  }
}
