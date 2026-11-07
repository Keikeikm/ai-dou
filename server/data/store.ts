import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { emptyMetrics, type DataFilter, type DataOverview, type PlayerAggregate, type PlayerProfile, type StoredEpisode, type EpisodeSummary, type DataPlayer } from '../../shared/game-data.js';
import { summarizeEpisode, summaryOnly, type EpisodeInput } from './episodes.js';
import type { GameRecord } from '../storage/score-store.js';

export class DataStore {
  private readonly db: DatabaseSync;
  readonly persistent: boolean;
  private closed = false;
  private readonly ownerToken = randomUUID();
  constructor(path = ':memory:') {
    this.persistent = path !== ':memory:';
    if (this.persistent) mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS data_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS data_episodes (id TEXT PRIMARY KEY, game TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL,
        steps INTEGER NOT NULL, summary_json TEXT NOT NULL, raw_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS data_participants (episode_id TEXT NOT NULL, profile_id TEXT NOT NULL, PRIMARY KEY(episode_id, profile_id));
      CREATE TABLE IF NOT EXISTS data_runtime (id INTEGER PRIMARY KEY CHECK(id=1), owner_pid INTEGER NOT NULL, owner_token TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS data_episodes_filter ON data_episodes(game, status, started_at, id);
      CREATE INDEX IF NOT EXISTS data_participants_profile ON data_participants(profile_id, episode_id);`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const owner = this.db.prepare('SELECT owner_pid FROM data_runtime WHERE id=1').get();
      if (owner && processAlive(Number(owner.owner_pid))) throw new Error('对局数据库已被另一个服务实例使用；请关闭原服务，或为新实例设置独立的 SCORE_DB_PATH。');
      this.db.prepare('INSERT OR REPLACE INTO data_runtime VALUES (1,?,?)').run(process.pid, this.ownerToken);
      this.db.prepare('INSERT OR IGNORE INTO data_profiles VALUES (?, ?, ?)').run('human_local', '我', Date.now());
      // Only recover sessions after acquiring sole ownership. A second running
      // server must never expose the first server's still-private active games.
      for (const row of this.db.prepare("SELECT id, summary_json FROM data_episodes WHERE status='active'").all()) {
        const summary = JSON.parse(String(row.summary_json)) as EpisodeSummary;
        summary.status = 'interrupted'; summary.updatedAt = Date.now();
        this.db.prepare("UPDATE data_episodes SET status='interrupted',summary_json=? WHERE id=?").run(JSON.stringify(summary), String(row.id));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK'); this.db.close(); throw error;
    }
  }
  profiles(): PlayerProfile[] { return this.db.prepare('SELECT * FROM data_profiles ORDER BY created_at, id').all().map((row) => ({ id: String(row.id), name: String(row.name), createdAt: Number(row.created_at) })); }
  profile(id: unknown = 'human_local'): PlayerProfile {
    if (typeof id !== 'string') throw new Error('请选择有效的玩家档案');
    const profile = this.profiles().find((item) => item.id === id);
    if (!profile) throw new Error('玩家档案不存在，请重新选择');
    return profile;
  }
  createProfile(name: unknown): PlayerProfile {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 32) throw new Error('玩家名字需要 1–32 个字符');
    const profile = { id: 'human_' + randomUUID().replaceAll('-', ''), name: name.trim(), createdAt: Date.now() };
    this.db.prepare('INSERT INTO data_profiles VALUES (?, ?, ?)').run(profile.id, profile.name, profile.createdAt);
    return profile;
  }
  save(input: EpisodeInput): void {
    const existing = this.db.prepare('SELECT status, steps, summary_json FROM data_episodes WHERE id=?').get(input.id);
    const steps = input.raw.game === 'doudizhu' ? input.raw.journal.turns.length : input.raw.steps.length;
    if (existing && (Number(existing.steps) > steps || String(existing.status) !== 'active' && input.status === 'active')) return;
    if (existing && Number(existing.steps) === steps && String(existing.status) === input.status) return;
    const episode = summarizeEpisode(input);
    if (existing && episode.status === 'finished') episode.finishedAt = (JSON.parse(String(existing.summary_json)) as EpisodeSummary).finishedAt ?? episode.finishedAt;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO data_episodes VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,
        steps=excluded.steps,summary_json=excluded.summary_json,raw_json=excluded.raw_json`).run(episode.id, episode.game, episode.status, episode.startedAt, episode.steps, JSON.stringify(summaryOnly(episode)), JSON.stringify(episode.raw));
      for (const player of episode.players) this.db.prepare('INSERT OR IGNORE INTO data_participants VALUES (?,?)').run(episode.id, player.profileId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  importLegacy(record: GameRecord) {
    if (this.db.prepare('SELECT id FROM data_episodes WHERE id=?').get(record.gameId)) return;
    this.save({ id: record.gameId, roomId: record.roomId, generation: record.generation, startedAt: record.createdAt, endedAt: record.createdAt, status: 'finished', imported: true,
      players: record.entries.map((entry) => ({ profileId: 'legacy_' + entry.id, name: entry.name, seat: entry.seat,
        kind: record.journal.turns.find((turn) => turn.seat === entry.seat)?.decisionKind ?? 'unknown', identity: 'legacy' })), raw: { game: 'doudizhu', journal: record.journal } });
  }
  importExisting() {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='games'").get()) return;
    const rows = this.db.prepare('SELECT * FROM games WHERE id NOT IN (SELECT id FROM data_episodes)').all();
    for (const row of rows) {
      const entries = this.db.prepare('SELECT * FROM score_entries WHERE game_id=? ORDER BY seat').all(String(row.id));
      this.importLegacy({ gameId: String(row.id), roomId: String(row.room_id), generation: Number(row.generation), createdAt: Number(row.created_at), seed: Number(row.seed),
        journal: JSON.parse(String(row.journal_json)), settlement: JSON.parse(String(row.settlement_json)),
        entries: entries.map((entry) => ({ id: String(entry.player_id), name: String(entry.name), seat: Number(entry.seat), delta: Number(entry.delta), beforeScore: Number(entry.before_score), afterScore: Number(entry.after_score) })) });
    }
  }
  get(id: string): StoredEpisode | null {
    const row = this.db.prepare("SELECT summary_json,raw_json FROM data_episodes WHERE id=? AND status!='active'").get(id);
    return row ? { ...JSON.parse(String(row.summary_json)), raw: JSON.parse(String(row.raw_json)) } as StoredEpisode : null;
  }
  private where(filter: DataFilter) {
    const conditions = ["e.status!='active'"];
    const args: (string | number)[] = [];
    if (filter.game) { conditions.push('e.game=?'); args.push(filter.game); }
    if (filter.status) { conditions.push('e.status=?'); args.push(filter.status); }
    if (filter.profileId) { conditions.push('EXISTS (SELECT 1 FROM data_participants p WHERE p.episode_id=e.id AND p.profile_id=?)'); args.push(filter.profileId); }
    if (filter.from !== undefined) { conditions.push('e.started_at>=?'); args.push(filter.from); }
    if (filter.to !== undefined) { conditions.push('e.started_at<=?'); args.push(filter.to); }
    return { sql: conditions.join(' AND '), args };
  }
  *episodes(filter: DataFilter): Generator<StoredEpisode> {
    const { sql, args } = this.where(filter);
    for (const row of this.db.prepare('SELECT summary_json,raw_json FROM data_episodes e WHERE ' + sql + ' ORDER BY started_at,id').iterate(...args)) {
      yield { ...JSON.parse(String(row.summary_json)), raw: JSON.parse(String(row.raw_json)) } as StoredEpisode;
    }
  }
  query(filter: DataFilter, limit = 20, offset = 0) {
    const { sql, args } = this.where(filter);
    const summaries = this.db.prepare('SELECT summary_json FROM data_episodes e WHERE ' + sql + ' ORDER BY started_at,id').all(...args).map((row) => JSON.parse(String(row.summary_json)) as EpisodeSummary);
    return { overview: aggregate(summaries, filter.profileId), games: summaries.slice().reverse().slice(offset, offset + limit), total: summaries.length, limit, offset,
      active: Number(this.db.prepare("SELECT count(*) AS n FROM data_episodes WHERE status='active'").get()!.n), profiles: this.profiles(), storage: { persistent: this.persistent, schemaVersion: 1 as const } };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.db.prepare('DELETE FROM data_runtime WHERE id=1 AND owner_token=?').run(this.ownerToken); }
    finally { this.db.close(); }
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export function dataPlayers(players: readonly { name: string; kind: string; seat: number; skill?: string }[], profile: PlayerProfile, model: string): DataPlayer[] {
  return players.map((player) => ({ name: player.kind === 'human' ? profile.name : player.name, seat: player.seat, kind: player.kind,
    profileId: player.kind === 'human' ? profile.id : 'agent_' + createHash('sha256').update(JSON.stringify([player.kind, player.name, player.seat, player.kind === 'deepseek' ? model : '', player.skill ?? ''])).digest('hex').slice(0, 32),
    identity: player.kind === 'human' ? 'profile' : 'agent', ...(player.kind === 'deepseek' ? { model } : {}), ...(player.skill ? { strategy: player.skill } : {}) }));
}
function aggregate(games: EpisodeSummary[], selected?: string): DataOverview {
  const result: DataOverview = { total: games.length, finished: 0, incomplete: 0, steps: 0, humanSteps: 0, fallbackSteps: 0, players: [], trend: [], distribution: {}, gameCounts: { bluff: 0, doudizhu: 0, blackjack: 0 } };
  const players = new Map<string, PlayerAggregate>();
  const days = new Map<string, DataOverview['trend'][number]>();
  for (const game of games) {
    const complete = game.status === 'finished';
    result.gameCounts[game.game]++; complete ? result.finished++ : result.incomplete++;
    const day = new Date(game.startedAt + 8 * 3600000).toISOString().slice(0, 10);
    const trend = days.get(day) ?? { day, games: 0, completed: 0, wins: 0, actions: 0 };
    trend.games++; if (complete) trend.completed++;
    for (const p of game.players) {
      const a = players.get(p.profileId) ?? { profileId: p.profileId, name: p.name, kind: p.kind, games: 0, wins: 0, draws: 0, completed: 0, metrics: emptyMetrics(), roles: {} };
      a.games++; if (complete) { a.completed++; if (p.won) a.wins++; if (p.outcome === 'push') a.draws = (a.draws ?? 0) + 1; const role = a.roles[p.role] ?? { games: 0, wins: 0 }; role.games++; if (p.won) role.wins++; a.roles[p.role] = role; }
      for (const key of Object.keys(a.metrics) as (keyof typeof a.metrics)[]) if (key !== 'distribution') a.metrics[key] += p.metrics[key];
      for (const [name, count] of Object.entries(p.metrics.distribution)) a.metrics.distribution[name] = (a.metrics.distribution[name] ?? 0) + count;
      players.set(p.profileId, a);
      if (!selected || selected === p.profileId) {
        result.steps += p.metrics.actions; result.fallbackSteps += p.metrics.fallbacks;
        if (p.kind === 'human') result.humanSteps += p.metrics.actions - p.metrics.fallbacks;
        trend.actions += p.metrics.actions; if (p.won) trend.wins++;
        for (const [name, count] of Object.entries(p.metrics.distribution)) result.distribution[name] = (result.distribution[name] ?? 0) + count;
      }
    }
    days.set(day, trend);
  }
  result.players = [...players.values()].sort((a, b) => b.games - a.games);
  result.trend = [...days.values()]; return result;
}
