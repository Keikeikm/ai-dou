import { afterEach, describe, expect, it } from 'vitest';
import { loadStrategySkill } from '../server/agents/skills.js';
import { createTacticalSummary } from '../server/agents/tactical-summary.js';
import { strategySkills, type SkillId } from '../shared/strategy-skills.js';
import { DeepSeekDecisionAgent, type DeepSeekCompletionRequest } from '../server/agents/deepseek.js';
import { createAgentRequest } from '../server/agents/protocol.js';
import { RoomManager } from '../server/rooms/room-manager.js';
import { replayJournal, type ModelResponse } from '../server/rooms/scheduler.js';
import { createGame, type GameState } from '../server/game/game.js';
import { applyGameAction } from '../server/game/actions.js';
import { cardsFromRanks } from '../server/game/cards.js';
import { identifyCombination } from '../server/game/combos.js';

const managers: RoomManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.dispose(); });
const context = (sequence = 1) => ({ sequence, deadline: Date.now() + 15000, signal: new AbortController().signal });
const completion = (content = '{"action_index":0}', usage?: unknown) => ({ choices: [{ finish_reason: 'stop', message: { content } }], usage });

describe('short strategy skills', () => {
  it('loads bounded trusted Markdown once, with stable immutable metadata', () => {
    for (const definition of strategySkills) {
      const skill = loadStrategySkill(definition.id);
      expect(skill).toBe(loadStrategySkill(definition.id));
      expect(skill.content.length).toBeLessThanOrEqual(800);
      expect(skill.content.length).toBeGreaterThan(150);
      expect(skill.metadata).toMatchObject({ id: definition.id, name: definition.name, version: 1 });
      expect(skill.metadata.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(Object.isFrozen(skill.metadata)).toBe(true);
    }
    expect(() => loadStrategySkill('../.env' as SkillId)).toThrow(/Unknown/);
  });

  it('keeps identical fixed prefixes across rounds and rooms without additional model calls', async () => {
    const captured: DeepSeekCompletionRequest[] = [];
    const transport = async (_credentials: unknown, request: DeepSeekCompletionRequest) => { captured.push(request); return completion(); };
    const agent = new DeepSeekDecisionAgent('Player', () => 'test-only-key', 'room_123456abcdef', 1, { skill: 'tempo', transport });
    const initial = createGame(7);
    await agent.decide(initial, context());
    await agent.decide(applyGameAction(initial, 0, { type: 'call', score: 0 }), context(2));
    await new DeepSeekDecisionAgent('Another', () => 'another-test-key', 'room_abcdef123456', 9, { skill: 'tempo', transport }).decide(createGame(17), context(11));
    expect(captured).toHaveLength(3);
    expect(new Set(captured.map((request) => request.messages[0].content)).size).toBe(1);
    expect(captured[0].messages[0].content).toContain('控场进攻型');
    expect(captured[0].messages[0].content).not.toMatch(/room_|test-only-key|Another|deadline/);
    expect(captured.every((request) => request.messages.length === 2)).toBe(true);
    const payload = JSON.parse(captured[1].messages[1].content);
    expect(payload.game.history).toHaveLength(1);
    expect(payload.tactical_summary).toBeDefined();
    expect(payload.action_options.every((action: object) => !('request_id' in action) && !('protocol_version' in action))).toBe(true);
  });

  it('summarizes only own structure, public team identity, played cards and urgency', () => {
    const own = cardsFromRanks(['3', '3', '3', '3', '4', '4', '4', '5', '5', '5', '6', '7', '8', '9', 'A', '2', 'little-joker', 'big-joker']);
    const publicPair = cardsFromRanks(['J', 'J']);
    const state: GameState = { ...createGame(7), phase: 'playing', currentSeat: 1, landlord: 0,
      hands: [cardsFromRanks(['Q']), own, cardsFromRanks(['K'])],
      lastPlay: { seat: 2, combination: identifyCombination(publicPair)! },
      logs: [{ seat: 0, action: 'deal', cards: [], message: 'PRIVATE_DEAL_TEXT' }, { seat: 0, action: 'call', cards: [], score: 3 },
        { seat: 2, action: 'play', cards: publicPair }, { seat: 0, action: 'pass', cards: [] }] };
    const request = createAgentRequest(state, { roomId: 'room_123456abcdef', generation: 1, round: 4, deadline: 5000 });
    const summary = createTacticalSummary(request, 0);
    expect(summary.hand_structure).toMatchObject({ bomb_ranks: ['3'], triple_ranks: ['4', '5'], rocket: true, control_card_count: 4,
      straight_runs: [['3', '4', '5', '6', '7', '8', '9']], pair_runs: [['3', '4', '5']], airplane_runs: [['3', '4', '5']] });
    expect(summary.team).toEqual({ landlord_seat: 0, teammate_seat: 2, opponent_seats: [0], urgent_opponents: [0], teammate_near_finish: true });
    expect(summary.public_play).toEqual({ played_by_rank: { J: 2 }, played_counts: [0, 0, 2], bomb_count: 0,
      last_play_type: 'pair', last_play_relation: 'teammate', passes_since_last_play: 1 });
    expect(JSON.stringify(request)).not.toContain('PRIVATE_DEAL_TEXT');
  });

  it('does not change model payloads when hidden hands or unrevealed bottom cards change', async () => {
    const captured: string[] = [];
    const agent = new DeepSeekDecisionAgent('Player', () => 'test', 'room_123456abcdef', 1, { skill: 'teamwork', transport: async (_credentials, request) => {
      captured.push(JSON.stringify(request)); return completion();
    } });
    const initial = createGame(7);
    const changed: GameState = { ...initial, hands: [initial.hands[0], [...initial.hands[2]], [...initial.hands[1]]], bottomCards: [...initial.bottomCards].reverse() };
    const sameContext = context();
    await agent.decide(initial, sameContext);
    await agent.decide(changed, sameContext);
    expect(captured[0]).toBe(captured[1]);
    for (const card of [...initial.hands[1], ...initial.hands[2], ...initial.bottomCards]) expect(captured[0]).not.toContain(card.id);
    const request = createAgentRequest(initial, { roomId: 'room_123456abcdef', generation: 1, round: 1, deadline: 5000 });
    expect(createTacticalSummary(request, null).team).toEqual({ landlord_seat: null, teammate_seat: null, opponent_seats: [], urgent_opponents: [], teammate_near_finish: false });
    const playing = applyGameAction(initial, 0, { type: 'call', score: 3 });
    const hiddenChanged: GameState = { ...playing, hands: [playing.hands[0], [...playing.hands[2]], [...playing.hands[1]]] };
    await agent.decide(playing, sameContext);
    await agent.decide(hiddenChanged, sameContext);
    expect(captured[2]).toBe(captured[3]);
    for (const card of [...playing.hands[1], ...playing.hands[2]]) expect(captured[2]).not.toContain(card.id);
    const landlordRequest = createAgentRequest(playing, { roomId: 'room_123456abcdef', generation: 1, round: 2, deadline: 5000 });
    expect(createTacticalSummary(landlordRequest, 0).team).toMatchObject({ landlord_seat: 0, teammate_seat: null, opponent_seats: [1, 2] });
  });

  it('assigns distinct default skills by actual seat, supports overrides and preserves them on new games', async () => {
    const prefixes: string[] = [];
    const manager = new RoomManager({ deepseek: { apiKey: 'test', transport: async (_credentials, request) => { prefixes.push(request.messages[0].content); return completion(); } } });
    managers.push(manager);
    const room = manager.create({ players: [2, 0, 1].map((seat) => ({ name: 'Player ' + seat, kind: 'deepseek', seat })) });
    expect(room.players.map((player) => player.skill)).toEqual(['structure', 'tempo', 'teamwork']);
    expect(prefixes).toHaveLength(0);
    for (let round = 0; round < 3; round += 1) await manager.control(room.id, 'step');
    expect(prefixes).toHaveLength(3);
    expect(new Set(prefixes).size).toBe(3);
    await manager.control(room.id, 'new-game');
    expect(manager.get(room.id).players.map((player) => player.skill)).toEqual(['structure', 'tempo', 'teamwork']);
    expect(prefixes).toHaveLength(3);
    const custom = manager.create({ players: [{ id: 'custom', name: 'Custom', kind: 'deepseek', skill: 'teamwork' }] });
    expect(custom.players[0].skill).toBe('teamwork');
    expect(() => manager.join(custom.id, { id: 'custom', name: 'Custom', kind: 'deepseek', skill: 'tempo' })).toThrow(/conflict/);
    expect(() => manager.create({ players: [{ name: 'Invalid', kind: 'deepseek', skill: '../.env' as SkillId }] })).toThrow(/Unknown/);
    expect(() => manager.create({ players: [{ name: 'Bot', kind: 'greedy', skill: 'tempo' }] })).toThrow(/only supported/);
  });

  it('records real cache counters and strategy on accepted and invalid responses, not guessed cache hits', async () => {
    const records: ModelResponse[] = [];
    let invalid = false;
    const agent = new DeepSeekDecisionAgent('Player', () => 'test', 'room_123456abcdef', 1, { skill: 'teamwork', transport: async () => completion(invalid ? '{}' : '{"action_index":0}', {
      prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20, unknown: 'private',
    }) });
    const decisionContext = { ...context(), recordModelResponse: (record: ModelResponse) => records.push(record) };
    await agent.decide(createGame(7), decisionContext);
    invalid = true;
    await expect(agent.decide(createGame(7), decisionContext)).rejects.toThrow();
    expect(records.map((record) => record.status)).toEqual(['accepted', 'invalid']);
    for (const record of records) {
      expect(record.usage).toEqual({ promptTokens: 100, completionTokens: 5, totalTokens: 105, cacheHitTokens: 80, cacheMissTokens: 20 });
      expect(record.strategy).toEqual(loadStrategySkill('teamwork').metadata);
      expect(JSON.stringify(record)).not.toContain('private');
    }
  });

  it.each([undefined, {}, { prompt_cache_hit_tokens: -1, prompt_cache_miss_tokens: '20' }, { prompt_cache_hit_tokens: Infinity, prompt_cache_miss_tokens: Number.MAX_SAFE_INTEGER + 1 }])('omits missing or unsafe cache usage: %j', async (usage) => {
    let record!: ModelResponse;
    const agent = new DeepSeekDecisionAgent('Player', () => 'test', 'room_123456abcdef', 1, { transport: async () => completion('{"action_index":0}', usage) });
    await agent.decide(createGame(7), { ...context(), recordModelResponse: (value) => { record = value; } });
    expect(record.usage).toBeUndefined();
  });

  it('preserves skill metadata and cache usage in completed archives without replay model calls', async () => {
    let calls = 0;
    const manager = new RoomManager({ deepseek: { apiKey: 'test', transport: async () => { calls += 1; return completion('{"action_index":0}', { prompt_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 }); } } });
    managers.push(manager);
    const room = manager.create({ seed: 7, players: [0, 1, 2].map((seat) => ({ name: 'AI ' + seat, kind: 'deepseek', seat })) });
    for (let turn = 0; turn < 300 && manager.get(room.id).status !== 'finished'; turn += 1) await manager.control(room.id, 'step');
    expect(manager.get(room.id).status).toBe('finished');
    const record = manager.getGameRecord(room.gameId);
    expect(record.journal.turns.every((turn) => turn.modelResponse?.strategy?.id === strategySkills[turn.seat].id && turn.modelResponse.usage?.cacheMissTokens === 100)).toBe(true);
    const before = calls;
    expect(replayJournal(record.journal)).toEqual(manager.getReplay(room.id).snapshots);
    expect(calls).toBe(before);
  });
});
