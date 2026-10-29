import { mkdtempSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ScoreStore, gameIdFor, type ScorePlayer } from '../server/storage/score-store.js';
import { createDefaultBots } from '../server/agents/bots.js';
import { GameScheduler, replayJournal, type GameJournal } from '../server/rooms/scheduler.js';
import { RoomManager } from '../server/rooms/room-manager.js';
import { createReplayServer } from '../server/http/replay-server.js';

const stores: ScoreStore[] = [];
const managers: RoomManager[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    for (const file of readdirSync(directory)) unlinkSync(join(directory, file));
    rmdirSync(directory);
  }
});

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), 'ai-dou-scoring-'));
  directories.push(directory);
  return join(directory, 'scores.sqlite');
}

function store(path?: string) {
  const ledger = new ScoreStore(path);
  stores.push(ledger);
  return ledger;
}

const players: ScorePlayer[] = [
  { id: 'stable-a', name: 'Random Bot', seat: 0 },
  { id: 'stable-b', name: 'Greedy Bot', seat: 1 },
  { id: 'stable-c', name: 'Greedy Bot', seat: 2 },
];
const registration = players.map((player) => ({ ...player, kind: player.seat === 0 ? 'random' as const : 'greedy' as const }));

async function completeJournal(seed = 7, baseScore = 1) {
  const scheduler = new GameScheduler(createDefaultBots(seed), { seed, baseScore });
  for (let turn = 0; turn < 300 && scheduler.getSession().status !== 'finished'; turn += 1) await scheduler.step();
  const journal = scheduler.getJournal();
  scheduler.stop();
  return journal;
}

async function completeRoom(manager: RoomManager, id: string) {
  for (let turn = 0; turn < 300 && manager.get(id).status !== 'finished'; turn += 1) await manager.control(id, 'step');
  expect(manager.get(id).status).toBe('finished');
}

describe('transactional score ledger', () => {
  it('credits all three players atomically and makes duplicate settlement idempotent', async () => {
    const ledger = store();
    const journal = await completeJournal(7, 5);
    expect(ledger.getScore('stable-a')).toBe(0);
    const record = ledger.record('room_0123456789ab', 1, players, journal, 1000);
    expect(record.gameId).toBe('game_0123456789ab_1');
    expect(record.entries.map((entry) => entry.delta)).toEqual(journal.settlement!.players.map((player) => player.delta));
    expect(record.entries.every((entry) => entry.beforeScore === 0 && entry.afterScore === entry.delta)).toBe(true);
    expect(ledger.record('room_0123456789ab', 1, players, journal, 2000)).toEqual(record);
    expect(ledger.listRoomGames(record.roomId).total).toBe(1);
    for (const entry of record.entries) expect(ledger.getPlayerLedger(entry.id)).toMatchObject({ score: entry.afterScore, total: 1 });
    expect(() => ledger.record(record.roomId, 1, [{ ...players[0], id: 'someone-else' }, ...players.slice(1)], journal)).toThrow(/Conflicting/);
    expect(ledger.getScore('someone-else')).toBe(0);
  });

  it('accumulates by stable Agent ID across generations and rooms while preserving historical balances', async () => {
    const ledger = store();
    const firstJournal = await completeJournal();
    const secondJournal = await completeJournal(21, 3);
    const first = ledger.record('room_0123456789ab', 1, players, firstJournal, 1000);
    const second = ledger.record(first.roomId, 2, players, secondJournal, 2000);
    const third = ledger.record('room_abcdef012345', 1, players, firstJournal, 3000);
    expect(ledger.getGame(first.gameId)).toEqual(first);
    for (const seat of [0, 1, 2]) {
      expect(second.entries[seat].beforeScore).toBe(first.entries[seat].afterScore);
      expect(third.entries[seat].beforeScore).toBe(second.entries[seat].afterScore);
      expect(ledger.getScore(players[seat].id)).toBe(first.entries[seat].delta + second.entries[seat].delta + third.entries[seat].delta);
    }
    expect(ledger.listRoomGames(first.roomId, 1, 0).games[0].gameId).toBe(second.gameId);
    expect(ledger.listRoomGames(first.roomId, 1, 1).games[0].gameId).toBe(first.gameId);
    expect(ledger.getPlayerLedger('stable-a', 1, 1).entries[0].gameId).toBe(second.gameId);
    expect(ledger.getPlayerLedger('unknown')).toMatchObject({ score: 0, total: 0, entries: [] });
  });

  it('keeps records, balances and verifiable logs after database reopen', async () => {
    const path = databasePath();
    const first = store(path);
    const journal = await completeJournal();
    const record = first.record('room_0123456789ab', 1, players, journal);
    first.close();
    const restored = store(path);
    expect(restored.getGame(record.gameId)).toEqual(record);
    expect(replayJournal(restored.getGame(record.gameId)!.journal)).toEqual(replayJournal(journal));
    expect(restored.record(record.roomId, 1, players, journal)).toEqual(record);
    expect(restored.getPlayerLedger('stable-a').total).toBe(1);
  });

  it('rolls back the game and all balance changes if a later seat insert fails', async () => {
    const path = databasePath();
    const ledger = store(path);
    const inspector = new DatabaseSync(path);
    try {
      inspector.exec("CREATE TRIGGER fail_second BEFORE INSERT ON score_entries WHEN NEW.seat = 1 BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
      const journal = await completeJournal();
      expect(() => ledger.record('room_0123456789ab', 1, players, journal)).toThrow(/simulated/);
      expect(ledger.listRoomGames('room_0123456789ab').total).toBe(0);
      for (const player of players) expect(ledger.getScore(player.id)).toBe(0);
      inspector.exec('DROP TRIGGER fail_second');
      expect(ledger.record('room_0123456789ab', 1, players, journal).entries).toHaveLength(3);
    } finally { inspector.close(); }
  });

  it('refuses balance overflow without partial writes or unsafe numeric rounding', async () => {
    const path = databasePath();
    const ledger = store(path);
    const journal = await completeJournal();
    const inspector = new DatabaseSync(path);
    try {
      const delta = journal.settlement!.players[0].delta;
      const boundary = delta > 0 ? Number.MAX_SAFE_INTEGER : Number.MIN_SAFE_INTEGER;
      inspector.prepare('INSERT INTO players VALUES (?, ?)').run(players[0].id, boundary);
      expect(() => ledger.record('room_0123456789ab', 1, players, journal)).toThrow(/safe integer/);
      expect(ledger.getScore(players[0].id)).toBe(boundary);
      expect(ledger.getScore(players[1].id)).toBe(0);
      expect(ledger.listRoomGames('room_0123456789ab').total).toBe(0);
    } finally { inspector.close(); }
  });

  it('rejects unfinished or tampered journals, duplicate identities and bad pagination', async () => {
    const ledger = store();
    const journal = await completeJournal();
    expect(() => ledger.record('room_0123456789ab', 1, players, { ...journal, status: 'paused' })).toThrow(/completed/);
    expect(() => ledger.record('room_0123456789ab', 1, [players[0], { ...players[1], id: players[0].id }, players[2]], journal)).toThrow(/players/);
    expect(() => ledger.record('room_0123456789ab', 1, players, { ...journal, settlement: { ...journal.settlement!, unitScore: 999 } })).toThrow(/match/);
    expect(() => gameIdFor('not-a-room', 1)).toThrow();
    expect(() => ledger.listRoomGames('room_0123456789ab', 101)).toThrow(/pagination/);
    expect(() => ledger.getPlayerLedger('stable-a', 20, -1)).toThrow(/pagination/);
    expect(ledger.listRoomGames('room_0123456789ab').total).toBe(0);
  });
});

describe('room scoring lifecycle', () => {
  it('settles once on finish, preserves old records on reset and retains them after room reclamation', async () => {
    let now = 1000;
    const manager = new RoomManager({ now: () => now, closedRetentionMs: 1 });
    managers.push(manager);
    const room = manager.create({ players: registration, baseScore: 5 });
    expect(manager.get(room.id).players.every((player) => player.score === 0)).toBe(true);
    await completeRoom(manager, room.id);
    const first = manager.getReplay(room.id);
    expect(first.accounting?.status).toBe('recorded');
    (first.accounting!.entries[0] as { afterScore: number }).afterScore = 999999;
    expect(manager.getReplay(room.id).accounting!.entries[0].afterScore).not.toBe(999999);
    const saved = manager.getGameRecord(room.gameId);
    expect(saved.settlement).toEqual(first.snapshots.at(-1)?.settlement);
    await manager.control(room.id, 'settle');
    await manager.control(room.id, 'pause');
    manager.watch(room.id, () => undefined)();
    expect(manager.getRoomGames(room.id).total).toBe(1);
    await manager.control(room.id, 'reset');
    expect(manager.getReplay(room.id).accounting).toBeNull();
    expect(manager.getRoomGames(room.id).games[0].gameId).toBe(saved.gameId);
    now = 2000;
    await completeRoom(manager, room.id);
    expect(manager.getRoomGames(room.id).total).toBe(2);
    const second = manager.getGameRecord(manager.get(room.id).gameId);
    for (const entry of second.entries) {
      const previous = saved.entries.find((savedEntry) => savedEntry.id === entry.id)!;
      expect(entry.beforeScore).toBe(previous.afterScore);
      expect(manager.getPlayerLedger(entry.id)).toMatchObject({ score: previous.delta + entry.delta, total: 2 });
    }
    manager.close(room.id);
    now = 2002;
    manager.sweep();
    expect(() => manager.get(room.id)).toThrow(/not found/);
    expect(manager.getGameRecord(saved.gameId)).toEqual(saved);
    expect(manager.getRoomGames(room.id).total).toBe(2);
  });

  it('does not award points for abandoned or reset partial games', async () => {
    const manager = new RoomManager();
    managers.push(manager);
    const room = manager.create({ players: registration });
    await manager.control(room.id, 'step');
    await manager.control(room.id, 'reset');
    await manager.control(room.id, 'step');
    manager.close(room.id);
    expect(manager.getRoomGames(room.id).total).toBe(0);
    for (const player of players) expect(manager.getPlayerLedger(player.id).score).toBe(0);
    await expect(manager.control(room.id, 'settle')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('reports storage failure, blocks reset, retains closed unposted games and retries without double credit', async () => {
    class FailingStore extends ScoreStore {
      fail = true;
      override record(roomId: string, generation: number, players: readonly ScorePlayer[], journal: GameJournal, createdAt?: number) {
        if (this.fail) throw new Error('Storage unavailable');
        return super.record(roomId, generation, players, journal, createdAt);
      }
    }
    const ledger = new FailingStore(); stores.push(ledger);
    let now = 1000;
    const manager = new RoomManager({ scoreStore: ledger, now: () => now, closedRetentionMs: 1 }); managers.push(manager);
    const room = manager.create({ players: registration });
    await completeRoom(manager, room.id);
    expect(manager.getReplay(room.id).accounting?.status).toBe('error');
    expect(manager.getRoomGames(room.id).total).toBe(0);
    await expect(manager.control(room.id, 'reset')).rejects.toMatchObject({ statusCode: 503 });
    manager.close(room.id);
    now = 2000;
    manager.sweep();
    expect(manager.get(room.id).status).toBe('closed');
    ledger.fail = false;
    await manager.control(room.id, 'settle');
    await manager.control(room.id, 'settle');
    expect(manager.getRoomGames(room.id).total).toBe(1);
    manager.sweep();
    expect(() => manager.get(room.id)).toThrow(/not found/);
  });
});

describe('persistent scoring HTTP API', () => {
  it('queries results, deltas, archives and replay after a server restart without exposing Agent keys', async () => {
    const path = databasePath();
    let server = createReplayServer({ scoreDatabasePath: path, stepIntervalMs: 0, baseScore: 5 });
    const listen = async () => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return 'http://127.0.0.1:' + (server.address() as AddressInfo).port; };
    const close = async () => new Promise<void>((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections(); });
    let origin = await listen();
    const post = async (url: string, body: unknown) => fetch(origin + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const created = await (await post('/api/rooms', { seed: 7, players: [
        { name: 'Random Bot', kind: 'random', seat: 0 }, { name: 'Greedy Bot', kind: 'greedy', seat: 1 }, { name: 'Greedy Bot', kind: 'greedy', seat: 2 },
      ] })).json();
      const base = '/api/rooms/' + created.id;
      let replay = await (await fetch(origin + base + '/replay')).json();
      expect(replay.room.baseScore).toBe(5);
      for (let turn = 0; turn < 300 && replay.session.status !== 'finished'; turn += 1) replay = await (await post(base + '/control', { action: 'step' })).json();
      expect(replay.accounting.status).toBe('recorded');
      const gameId = replay.accounting.gameId;
      const roomId = replay.room.id;
      const record = await (await fetch(origin + '/api/games/' + gameId)).json();
      expect(record.settlement.baseScore).toBe(5);
      expect((await (await fetch(origin + '/api/rooms/' + roomId + '/games')).json()).total).toBe(1);
      const journalResponse = await fetch(origin + '/api/games/' + gameId + '/journal');
      expect(journalResponse.headers.get('content-disposition')).toContain(gameId);
      expect(replayJournal(await journalResponse.json())).toEqual(replay.snapshots);
      expect((await (await fetch(origin + '/api/games/' + gameId + '/replay')).json()).snapshots).toEqual(replay.snapshots);
      expect((await fetch(origin + '/api/games/' + gameId, { method: 'HEAD' })).status).toBe(200);
      expect((await post('/api/games/' + gameId, {})).status).toBe(405);
      expect((await fetch(origin + '/api/rooms/' + roomId + '/games?limit=101')).status).toBe(400);
      expect((await fetch(origin + '/api/players/test/score?offset=-1')).status).toBe(400);
      expect((await fetch(origin + '/api/games/game_ffffffffffff_1')).status).toBe(404);
      expect((await post('/api/rooms', { baseScore: 0 })).status).toBe(400);
      expect((await fetch(origin + '/scoring')).status).toBe(200);
      expect((await fetch(origin + '/agent-api')).status).toBe(200);
      expect((await fetch(origin + '/spectating')).status).toBe(200);
      await post(base + '/control', { action: 'reset' });
      expect((await (await fetch(origin + '/api/rooms/' + roomId + '/games')).json()).total).toBe(1);
      await close();
      server = createReplayServer({ scoreDatabasePath: path });
      origin = await listen();
      expect((await fetch(origin + '/api/rooms/' + roomId)).status).toBe(404);
      expect(await (await fetch(origin + '/api/games/' + gameId)).json()).toEqual(record);
      const archivePage = await fetch(origin + '/games/' + gameId);
      expect(archivePage.status).toBe(200);
      expect(archivePage.headers.get('content-type')).toContain('text/html');
      expect(await archivePage.text()).toContain('id="root"');
      const archiveHead = await fetch(origin + '/games/' + gameId, { method: 'HEAD' });
      expect(archiveHead.status).toBe(200);
      expect(await archiveHead.text()).toBe('');
      expect((await post('/games/' + gameId, {})).status).toBe(405);
      expect((await fetch(origin + '/games/game_ffffffffffff_1')).status).toBe(404);
      for (const entry of record.entries) expect(await (await fetch(origin + '/api/players/' + entry.id + '/score')).json()).toMatchObject({ score: entry.afterScore, total: 1 });
      expect(JSON.stringify(record)).not.toMatch(/api_key|api_url|Authorization/);
    } finally { await close(); }
  });
});
