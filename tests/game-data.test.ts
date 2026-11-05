import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { DataStore, dataPlayers } from '../server/data/store.js';
import { summarizeEpisode, trainingTransitions, episodeSnapshots } from '../server/data/episodes.js';
import { createReplayServer } from '../server/http/replay-server.js';
import { RoomManager } from '../server/rooms/room-manager.js';
import { BluffRooms } from '../server/bluff/rooms.js';
import { ScoreStore } from '../server/storage/score-store.js';
import { bluffEpisode, ddEpisode } from './data-fixture.js';
import type { BluffObservation } from '../shared/bluff.js';
import { BLUFF_RULES_VERSION, LEGACY_BLUFF_RULES_VERSION, type BluffAction } from '../shared/bluff.js';
import { createBluffGame, applyBluffAction } from '../server/bluff/game.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanups.splice(0).reverse()) await fn(); });
function store() { const data = new DataStore(); cleanups.push(() => data.close()); return data; }
function temp() { const path = mkdtempSync(join(tmpdir(), 'ai-dou-data-')); cleanups.push(() => rmSync(path, { recursive: true, force: true })); return join(path, 'data.sqlite'); }

describe('persistent multi-game dataset', () => {
  it.each([LEGACY_BLUFF_RULES_VERSION, BLUFF_RULES_VERSION])('reconstructs and exports the correct next actor for %s', (version) => {
    const input = bluffEpisode('bluff_versions', false);
    if (input.raw.game !== 'bluff') throw new Error();
    const state = createBluffGame(() => .999, version);
    input.raw.initialHands = structuredClone(state.hands); input.raw.steps = [];
    if (version === BLUFF_RULES_VERSION) input.raw.rulesVersion = version;
    else delete input.raw.rulesVersion; // Existing v1 records predate the raw version field.
    const play = (action: BluffAction) => {
      const seat = state.turn;
      input.raw.game === 'bluff' && input.raw.steps.push({ seat, action, source: seat === 0 ? 'human' : 'model', at: 1000, durationMs: 0 });
      applyBluffAction(state, seat, action);
    };
    play({ type: 'play', cards: [state.hands[0].find((card) => card.rank === 'A')!.id] }); play({ type: 'challenge' });
    const nextSeat = version === BLUFF_RULES_VERSION ? 0 : 1;
    expect(state.turn).toBe(nextSeat);
    play({ type: 'play', cards: [state.hands[nextSeat][0].id] });
    const episode = summarizeEpisode({ ...input, status: 'abandoned' });
    expect(episode.rulesVersion).toBe(version);
    expect(episodeSnapshots(episode)[2]).toMatchObject({ turn: nextSeat, lastReveal: { nextSeat } });
    expect([...trainingTransitions(episode)][2]).toMatchObject({ actor_seat: nextSeat, rules_version: version });
  });
  it('blocks a second writer from exposing another live server’s private active records', () => {
    const path = temp(); const first = new DataStore(path); cleanups.push(() => first.close());
    first.save(bluffEpisode('bluff_private', false));
    expect(() => new DataStore(path)).toThrow('另一个服务实例');
    expect(first.query({}).active).toBe(1); expect(first.get('bluff_private')).toBeNull();
    first.close(); const recovered = new DataStore(path); cleanups.push(() => recovered.close());
    expect(recovered.get('bluff_private')?.status).toBe('interrupted');
  });
  it('retains stable profiles, committed actions and interrupted sessions across reopening SQLite', () => {
    const path = temp(); const first = new DataStore(path); const p = first.createProfile('小林');
    const input = bluffEpisode('bluff_saved_1', false); input.players[0] = { ...input.players[0], profileId: p.id, name: p.name };
    first.save(input); expect(first.get(input.id)).toBeNull(); expect(first.query({}).active).toBe(1); first.close();
    const second = new DataStore(path); cleanups.push(() => second.close());
    expect(second.profile(p.id)).toEqual(p); expect(second.get(input.id)).toMatchObject({ status: 'interrupted', steps: 3, finishedAt: null });
    expect(second.query({ profileId: p.id }).overview).toMatchObject({ total: 1, finished: 0, humanSteps: 1 });
  });
  it('computes actual bluff/challenge statistics and incomplete outcomes from rules', () => {
    const input = bluffEpisode('bluff_challenge_1', false);
    if (input.raw.game !== 'bluff') throw new Error();
    input.raw.steps = [input.raw.steps[0], { ...input.raw.steps[1], action: { type: 'challenge' } }];
    input.status = 'abandoned'; const episode = summarizeEpisode(input);
    expect(episode.players[0]).toMatchObject({ won: null, metrics: { plays: 1, bluffs: 1, cardsPlayed: 4 } });
    expect(episode.players[1].metrics).toMatchObject({ responses: 1, challenges: 1, challengesWon: 1 });
  });
  it('aggregates all filtered games independently of pagination and separates incomplete outcomes', () => {
    const data = store(); for (let i = 0; i < 15; i++) data.save({ ...bluffEpisode('bluff_' + i), startedAt: 1000 + i });
    const incomplete = bluffEpisode('bluff_incomplete', false); data.save({ ...incomplete, status: 'abandoned', startedAt: 999 });
    const result = data.query({ game: 'bluff', profileId: 'human_local', from: 0, to: 2000 }, 5, 5);
    expect(result.games).toHaveLength(5); expect(result.overview).toMatchObject({ total: 16, finished: 15, incomplete: 1 });
    expect(result.overview.players.find((p) => p.profileId === 'human_local')).toMatchObject({ wins: 15, completed: 15, games: 16 });
    expect(data.query({ game: 'doudizhu' }).total).toBe(0); expect([...data.episodes({ status: 'finished' })]).toHaveLength(15);
  });
  it('does not overwrite a finished game with stale actions or an active state', () => {
    const data = store(); const complete = bluffEpisode(); data.save(complete); const saved = data.get(complete.id);
    data.save(bluffEpisode(complete.id, false)); expect(data.get(complete.id)).toEqual(saved);
  });
  it('exports player-visible transitions, stable episode splits and per-seat terminal rewards', () => {
    const input = bluffEpisode(); const episode = summarizeEpisode(input); const transitions = [...trainingTransitions(episode)];
    expect(new Set(transitions.map((t) => t.split)).size).toBe(1);
    const beforeResponse = transitions[1].observation as BluffObservation;
    if (input.raw.game !== 'bluff') throw new Error();
    for (const card of input.raw.initialHands[0]) expect(JSON.stringify(beforeResponse)).not.toContain(card.id);
    expect(beforeResponse).not.toHaveProperty('hands'); expect(beforeResponse).not.toHaveProperty('seed');
    expect(transitions.at(-1)).toMatchObject({ terminated: true, truncated: false, reward: -1, reward_by_seat: [{ seat: 0, reward: 1 }, { seat: 1, reward: -1 }] });
    expect(transitions.every((t) => t.next_observation_timing === 'after_one_environment_action')).toBe(true);
    expect([...trainingTransitions(episode, 'human_local')].every((t) => t.actor_id === 'human_local')).toBe(true);
    const partial = [...trainingTransitions(summarizeEpisode({ ...bluffEpisode('partial', false), status: 'interrupted' }))];
    expect(partial.at(-1)).toMatchObject({ terminated: false, truncated: true, reward: null, outcome: null });
    expect(episodeSnapshots(episode)).toHaveLength(transitions.length + 1);
  });
  it('keeps DD private observations and removes model text, credential-like details and fallback imitation labels', () => {
    const input = ddEpisode(); if (input.raw.game !== 'doudizhu') throw new Error();
    input.raw.journal = { ...input.raw.journal, turns: input.raw.journal.turns.map((turn, i) => i ? turn : { ...turn, source: 'fallback', reason: 'invalid', detail: 'secret-key', modelResponse: { provider: 'deepseek', model: 'test', status: 'invalid', durationMs: 10, content: 'secret-key' } }) };
    const episode = summarizeEpisode(input); expect(JSON.stringify(episode)).not.toContain('secret-key');
    const transitions = [...trainingTransitions(episode)]; expect(transitions[0]).toMatchObject({ behavior_source: 'fallback', imitation_eligible: false });
    expect(transitions[0].observation).not.toHaveProperty('seed'); expect(transitions[0].observation).not.toHaveProperty('hands');
    expect(transitions[0].observation).toMatchObject({ hand_cards: expect.any(Array), bottom_cards: [] });
    expect(episode.players[0]).toMatchObject({ won: true, role: '地主', metrics: { fallbacks: 1 } });
    expect(episodeSnapshots(episode)).toHaveLength(transitions.length + 1);
  });
  it('imports existing DD history once without merging old identities by name', () => {
    const path = temp(); const scores = new ScoreStore(path); const input = ddEpisode(); if (input.raw.game !== 'doudizhu') throw new Error();
    scores.record(input.roomId, 1, input.players.map((p) => ({ id: p.profileId, name: '同名', seat: p.seat })), { ...input.raw.journal, players: ['同名', '同名', '同名'] }, 100);
    const data = new DataStore(path); cleanups.push(() => { data.close(); scores.close(); }); data.importExisting(); data.importExisting();
    const result = data.query({}); expect(result.total).toBe(1); expect(result.games[0].imported).toBe(true);
    expect(new Set(result.games[0].players.map((p) => p.profileId)).size).toBe(3); expect(data.query({ profileId: 'human_local' }).total).toBe(0);
  });
  it('uses stable human identity and separates bot policies and seats', () => {
    const data = store(); const p = data.createProfile('小林');
    const a = dataPlayers([{ name: '临时名字', kind: 'human', seat: 0 }, { name: '鲸鱼娘', kind: 'deepseek', seat: 1 }], p, 'model-1');
    expect(a[0]).toMatchObject({ profileId: p.id, name: '小林' }); expect(dataPlayers([{ name: '鲸鱼娘', kind: 'deepseek', seat: 1 }], p, 'model-1')[0].profileId).toBe(a[1].profileId);
    expect(dataPlayers([{ name: '鲸鱼娘', kind: 'deepseek', seat: 1 }], p, 'model-2')[0].profileId).not.toBe(a[1].profileId);
  });
  it('archives DD steps on reset and shutdown, keeping each generation', async () => {
    const data = store(); const manager = new RoomManager({ dataStore: data }); cleanups.push(() => manager.dispose());
    const room = manager.create({ players: [0, 1, 2].map((seat) => ({ name: 'bot' + seat, kind: 'greedy', seat })) });
    await manager.control(room.id, 'step'); expect(data.query({}).active).toBe(1);
    await manager.control(room.id, 'new-game'); expect(data.query({}).games[0]).toMatchObject({ generation: 1, status: 'abandoned', steps: 1 });
    await manager.control(room.id, 'step'); manager.dispose();
    expect(data.query({}).games.map((g) => g.status).sort()).toEqual(['abandoned', 'interrupted']);
  });
  it('commits Bluff actions before advancing and preserves complete games across restart', async () => {
    const data = store(); const p = data.createProfile('小林');
    const manager = new BluffRooms({ apiKey: 'secret-key', transport: async (_c, request) => {
      const view = JSON.parse(request.messages[1].content) as BluffObservation;
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(view.phase === 'respond' ? { type: 'accept' } : { type: 'play', cards: view.hand.slice(0, 4).map((c) => c.id) }) } }] };
    } }, 1000, data); cleanups.push(() => manager.dispose());
    const grant = manager.create({ profileId: p.id }); let view = grant.room;
    while (view.phase !== 'finished') {
      if (!view.thinking && view.turn === 0) manager.control(view.id, grant.token, { generation: view.generation, revision: view.revision, action: view.phase === 'respond' ? { type: 'accept' } : { type: 'play', cards: view.hand.slice(0, 4).map((c) => c.id) } });
      await new Promise((resolve) => setTimeout(resolve, 0)); view = manager.get(view.id, grant.token);
    }
    expect(data.query({ profileId: p.id, status: 'finished' }).total).toBe(1);
    expect(JSON.stringify([...data.episodes({})])).not.toContain('secret-key');
    manager.control(view.id, grant.token, { generation: view.generation, revision: view.revision, type: 'restart' });
    view = manager.get(view.id, grant.token); const save = vi.spyOn(data, 'save').mockImplementation(() => { throw new Error('disk full'); });
    expect(() => manager.control(view.id, grant.token, { generation: view.generation, revision: view.revision, action: { type: 'play', cards: [view.hand[0].id] } })).toThrow('保存失败');
    expect(manager.get(view.id, grant.token).revision).toBe(0); save.mockRestore();
  });
  it('serves filtered summaries, archived replay and streaming JSONL, without exposing live data', async () => {
    const data = store(); data.save(bluffEpisode()); data.save(bluffEpisode('bluff_live_1', false));
    const server = createReplayServer({ dataStore: data }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    expect((await (await fetch(base + '/api/data/overview?game=bluff')).json()).total).toBe(1);
    expect((await fetch(base + '/api/data/episodes/bluff_live_1')).status).toBe(404);
    expect((await (await fetch(base + '/api/data/episodes/bluff_test_1')).json()).snapshots.length).toBeGreaterThan(2);
    const exported = await fetch(base + '/api/data/export?format=transitions&profileId=human_local');
    expect(exported.headers.get('content-type')).toContain('ndjson'); expect(exported.headers.get('content-disposition')).toContain('attachment');
    const lines = (await exported.text()).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.length).toBeGreaterThan(0); expect(lines.every((line) => line.actor_id === 'human_local')).toBe(true);
    for (const query of ['status=active', 'game=bad', 'from=9&to=2', 'limit=0', 'from=NaN']) expect((await fetch(base + '/api/data/overview?' + query)).status).toBe(400);
    expect((await fetch(base + '/api/data/overview', { headers: { origin: 'https://other.test' } })).status).toBe(403);
    const response = await fetch(base + '/api/data/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '新玩家' }) });
    expect(response.status).toBe(201); expect((await response.json()).name).toBe('新玩家');
  });
});
