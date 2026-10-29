import { randomInt, randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { createDefaultBots, GreedyBot } from '../agents/bots.js';
import { GameScheduler, MAX_DECISION_TIMEOUT_MS, type DecisionAgent, type SchedulerOptions } from './scheduler.js';
import { AgentEndpointError, AgentEndpointPolicy, HttpDecisionAgent, normalizeApiKey, type AgentCredentials } from '../agents/http.js';
import { ScoreStore, gameIdFor, type ScoreEntry } from '../storage/score-store.js';
import { validateBaseScore } from '../game/scoring.js';
import { DEEPSEEK_API_URL, DeepSeekDecisionAgent, checkDeepSeekConnection, validateDeepSeekModel, type DeepSeekOptions } from '../agents/deepseek.js';
import { defaultSkillForSeat, validateSkillId, type SkillId } from '../../shared/strategy-skills.js';
import type { HumanControlGrant, HumanSubmission } from '../../shared/human-player.js';

export type RoomStatus = 'waiting' | 'ready' | 'playing' | 'finished' | 'closed';
export type AgentKind = 'random' | 'greedy' | 'http' | 'deepseek' | 'human';

export interface AgentRegistration {
  readonly id?: string;
  readonly name: string;
  readonly kind: AgentKind;
  readonly seat?: number;
  readonly api_url?: string;
  readonly api_key?: string | null;
  readonly skill?: SkillId;
}

export interface RoomPlayer {
  readonly id: string;
  readonly name: string;
  readonly kind: AgentKind;
  readonly seat: number;
  readonly hasApiKey?: boolean;
  readonly model?: string;
  readonly keySource?: 'seat' | 'server' | 'none';
  readonly skill?: SkillId;
}

export interface CreateRoomOptions {
  readonly seed?: number;
  readonly name?: string;
  readonly players?: readonly AgentRegistration[];
  readonly baseScore?: number;
}

export interface RoomManagerOptions extends Omit<SchedulerOptions, 'seed'> {
  readonly maxRooms?: number;
  readonly idleTimeoutMs?: number;
  readonly closedRetentionMs?: number;
  readonly sweepIntervalMs?: number;
  readonly now?: () => number;
  readonly agentFactory?: (player: RoomPlayer, seed: number) => DecisionAgent;
  readonly agentAllowedOrigins?: readonly string[];
  readonly scoreDatabasePath?: string;
  readonly scoreStore?: ScoreStore;
  readonly deepseek?: DeepSeekOptions;
  readonly deepseekTurnTimeoutMs?: number;
}

export class RoomError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

interface RoomRecord {
  readonly id: string;
  readonly name: string;
  seed: number;
  readonly baseScore: number;
  readonly createdAt: number;
  readonly players: RoomPlayer[];
  readonly credentials: Map<string, AgentCredentials>;
  humanControl?: HumanControlGrant | undefined;
  readonly listeners: Set<() => void>;
  updatedAt: number;
  closedAt?: number | undefined;
  closeReason?: string | undefined;
  scheduler?: GameScheduler | undefined;
  unsubscribe?: (() => void) | undefined;
  generation: number;
  revision: number;
  started: boolean;
  checkController?: AbortController | undefined;
  accounting?: { readonly status: 'recorded' | 'error'; readonly gameId: string; readonly entries: readonly ScoreEntry[] } | undefined;
}

function text(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) throw new RoomError(400, `Invalid ${label}`);
  return value.trim();
}

function builtInAgent(player: RoomPlayer, seed: number): DecisionAgent {
  const bot = player.kind === 'random' ? createDefaultBots(seed)[0] : new GreedyBot();
  return { name: player.name, kind: 'bot', decide: (state) => bot.decide(state) };
}

function randomSeed(previous?: number): number {
  const seed = randomInt(0, previous === undefined ? 0x100000000 : 0xffffffff);
  return previous !== undefined && seed >= previous ? seed + 1 : seed;
}

export class RoomManager {
  private readonly rooms = new Map<string, RoomRecord>();
  private readonly now: () => number;
  private readonly agentFactory: (player: RoomPlayer, seed: number) => DecisionAgent;
  private readonly agentPolicy: AgentEndpointPolicy;
  private readonly maxRooms: number;
  private readonly idleTimeoutMs: number;
  private readonly closedRetentionMs: number;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private readonly scoreStore: ScoreStore;
  private readonly ownsScoreStore: boolean;
  private disposed = false;
  private readonly deepseek: DeepSeekOptions;
  private readonly deepseekTurnTimeoutMs: number;

  constructor(private readonly options: RoomManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.agentFactory = options.agentFactory ?? builtInAgent;
    this.agentPolicy = new AgentEndpointPolicy(options.agentAllowedOrigins);
    this.deepseek = { apiKey: normalizeApiKey(options.deepseek?.apiKey), model: validateDeepSeekModel(options.deepseek?.model ?? 'deepseek-flash'), transport: options.deepseek?.transport };
    this.deepseekTurnTimeoutMs = options.deepseekTurnTimeoutMs ?? 15000;
    if (!Number.isInteger(this.deepseekTurnTimeoutMs) || this.deepseekTurnTimeoutMs < 1 || this.deepseekTurnTimeoutMs > MAX_DECISION_TIMEOUT_MS) throw new RoomError(400, 'Invalid DeepSeek decision timeout');
    this.maxRooms = options.maxRooms ?? 32;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60 * 1000;
    this.closedRetentionMs = options.closedRetentionMs ?? 5 * 60 * 1000;
    const sweepIntervalMs = options.sweepIntervalMs ?? 60000;
    for (const value of [this.maxRooms, this.idleTimeoutMs, this.closedRetentionMs, sweepIntervalMs]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RoomError(400, 'Invalid room limits');
    }
    validateBaseScore(options.baseScore ?? 1);
    this.scoreStore = options.scoreStore ?? new ScoreStore(options.scoreDatabasePath);
    this.ownsScoreStore = !options.scoreStore;
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweepTimer.unref();
  }

  getDeepSeekConfiguration() {
    return { model: this.deepseek.model, hasServerKey: Boolean(this.deepseek.apiKey), turnTimeoutMs: this.deepseekTurnTimeoutMs };
  }

  async checkAgent(id: string, playerId: string, signal?: AbortSignal) {
    const room = this.requireRoom(id);
    this.requireOpen(room);
    if (room.started) throw new RoomError(409, 'Connection checks are only allowed before a game starts');
    const player = room.players.find((candidate) => candidate.id === playerId);
    if (!player || player.kind !== 'deepseek') throw new RoomError(404, 'DeepSeek Agent not found');
    const apiKey = this.deepseekKey(room, playerId);
    if (!apiKey) throw new RoomError(409, 'Configure a DeepSeek API key before checking');
    if (room.checkController) throw new RoomError(409, 'A connection check is already in progress');
    const controller = new AbortController();
    room.checkController = controller;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try { return await checkDeepSeekConnection({ ...this.deepseek, apiKey, skill: player.skill }, this.deepseekTurnTimeoutMs, controller.signal); }
    finally { signal?.removeEventListener('abort', cancel); if (room.checkController === controller) room.checkController = undefined; }
  }

  create(input: CreateRoomOptions = {}) {
    if (this.disposed) throw new RoomError(503, 'Room manager is stopped');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RoomError(400, 'Invalid room options');
    this.sweep();
    if (this.rooms.size >= this.maxRooms) throw new RoomError(429, 'Room limit reached');
    const seed = input.seed ?? randomSeed();
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RoomError(400, 'Invalid room seed');
    const name = input.name === undefined ? '友谊对局' : text(input.name, 32, 'room name');
    let baseScore: number;
    try { baseScore = validateBaseScore(input.baseScore === undefined ? this.options.baseScore ?? 1 : input.baseScore); }
    catch { throw new RoomError(400, 'Base score must be an integer between 1 and 1000000'); }
    if (input.players !== undefined && (!Array.isArray(input.players) || input.players.length > 3)) throw new RoomError(400, 'A room has three seats');
    const ids = (input.players ?? []).map((player) => player?.id).filter((id) => id !== undefined);
    const seats = (input.players ?? []).map((player) => player?.seat).filter((seat) => seat !== undefined);
    if (new Set(ids).size !== ids.length) throw new RoomError(400, 'Duplicate initial agent id');
    if (new Set(seats).size !== seats.length) throw new RoomError(400, 'Initial seat is occupied more than once');
    let id: string;
    do { id = 'room_' + randomUUID().replaceAll('-', '').slice(0, 12); } while (this.rooms.has(id));
    const createdAt = this.now();
    const room: RoomRecord = { id, name, seed, baseScore, createdAt, updatedAt: createdAt, players: [], credentials: new Map(), listeners: new Set(), generation: 1, revision: 0, started: false };
    this.rooms.set(id, room);
    try { for (const player of input.players ?? []) this.join(id, player); }
    catch (error) { this.close(id, 'creation-failed'); this.rooms.delete(id); throw error; }
    return { ...this.get(id), ...(room.humanControl ? { humanControl: { ...room.humanControl } } : {}) };
  }

  get(id: string) {
    const room = this.requireRoom(id);
    return structuredClone({
      id, name: room.name, seed: room.seed, baseScore: room.baseScore, gameId: gameIdFor(id, room.generation), status: this.status(room), capacity: 3,
      players: [...room.players].sort((left, right) => left.seat - right.seat).map((player) => ({ ...player, score: this.scoreStore.getScore(player.id),
        ...(player.kind === 'http' ? { hasApiKey: Boolean(room.credentials.get(player.id)?.apiKey) } : player.kind === 'deepseek' ? {
          hasApiKey: Boolean(this.deepseekKey(room, player.id)), model: this.deepseek.model,
          keySource: room.credentials.get(player.id)?.apiKey ? 'seat' : this.deepseek.apiKey ? 'server' : 'none',
        } : {}) })), spectators: room.listeners.size,
      createdAt: room.createdAt, updatedAt: room.updatedAt, closedAt: room.closedAt, closeReason: room.closeReason,
      generation: room.generation, viewUrl: '/rooms/' + id,
    });
  }

  getReplay(id: string) {
    const room = this.requireRoom(id);
    const replay = room.scheduler?.getReplay() ?? {
      seed: room.seed, snapshots: [], turns: [],
      session: { status: 'idle' as const, turnTimeoutMs: this.options.turnTimeoutMs ?? 1500, stepIntervalMs: this.options.stepIntervalMs ?? 950 },
    };
    return { ...replay, generation: room.generation, revision: room.revision, room: this.get(id), accounting: structuredClone(room.accounting ?? null) };
  }

  getJournal(id: string) {
    const room = this.requireRoom(id);
    if (!room.scheduler) throw new RoomError(409, 'Three agents must join before a game exists');
    return { ...room.scheduler.getJournal(), roomId: id, generation: room.generation, gameId: gameIdFor(id, room.generation) };
  }

  getGameRecord(gameId: string) {
    const record = this.scoreStore.getGame(gameId);
    if (!record) throw new RoomError(404, 'Game record not found');
    return record;
  }

  getRoomGames(id: string, limit = 20, offset = 0) { return this.scoreStore.listRoomGames(id, limit, offset); }

  getPlayerLedger(id: string, limit = 20, offset = 0) { return this.scoreStore.getPlayerLedger(id, limit, offset); }

  join(id: string, input: AgentRegistration) {
    const room = this.requireRoom(id);
    this.requireOpen(room);
    if (!input || typeof input !== 'object') throw new RoomError(400, 'Invalid agent');
    const name = text(input.name, 32, 'agent name');
    if (!['random', 'greedy', 'http', 'deepseek', 'human'].includes(input.kind)) throw new RoomError(400, 'Unsupported agent kind');
    const credentials = this.validateCredentials(input);
    let requestedSkill: SkillId | undefined;
    if (input.skill !== undefined) {
      if (input.kind !== 'deepseek') throw new RoomError(400, 'Strategy skills are only supported for DeepSeek Agents');
      try { requestedSkill = validateSkillId(input.skill); }
      catch { throw new RoomError(400, 'Unknown DeepSeek strategy skill'); }
    }
    const playerId = input.id === undefined ? randomUUID() : text(input.id, 64, 'agent id');
    if (!/^[a-zA-Z0-9_-]+$/.test(playerId)) throw new RoomError(400, 'Invalid agent id');
    if (input.seat !== undefined && (!Number.isInteger(input.seat) || input.seat < 0 || input.seat > 2)) throw new RoomError(400, 'Invalid seat');
    const existing = room.players.find((player) => player.id === playerId);
    if (existing) {
      const previous = room.credentials.get(playerId);
      if (existing.name !== name || existing.kind !== input.kind || (input.seat !== undefined && input.seat !== existing.seat) ||
        previous?.apiUrl !== credentials?.apiUrl || previous?.apiKey !== credentials?.apiKey ||
        (requestedSkill !== undefined && existing.skill !== requestedSkill)) throw new RoomError(409, 'Agent registration conflict');
      return this.get(id);
    }
    if (this.status(room) !== 'waiting') throw new RoomError(409, 'Room is full or already started');
    if (input.kind === 'human' && room.players.some((player) => player.kind === 'human')) throw new RoomError(409, '每间房仅支持一位真人玩家');
    const seat = input.seat ?? [0, 1, 2].find((candidate) => !room.players.some((player) => player.seat === candidate))!;
    if (room.players.some((player) => player.seat === seat)) throw new RoomError(409, 'Seat is occupied');
    room.players.push({ id: playerId, name, kind: input.kind, seat, ...(input.kind === 'deepseek' ? { skill: requestedSkill ?? defaultSkillForSeat(seat) } : {}) });
    if (input.kind === 'human') room.humanControl = { playerId, seat, token: randomBytes(32).toString('hex') };
    if (credentials) room.credentials.set(playerId, credentials);
    try { if (room.players.length === 3) this.createGame(room); }
    catch (error) { room.players.pop(); room.credentials.delete(playerId); if (input.kind === 'human') room.humanControl = undefined; throw error; }
    this.publish(room);
    return { ...this.get(id), ...(input.kind === 'human' ? { humanControl: { ...room.humanControl! } } : {}) };
  }

  submitHumanAction(id: string, token: unknown, input: unknown) {
    const room = this.requireRoom(id);
    this.requireOpen(room);
    if (!room.humanControl || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)
      || !timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(room.humanControl.token, 'hex'))) throw new RoomError(403, '没有该真人席位的操控权限');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RoomError(400, '无效的真人操作请求');
    const submission = input as HumanSubmission;
    if (Object.keys(input).length !== 3 || !Number.isSafeInteger(submission.generation) || typeof submission.decisionId !== 'string' || submission.decisionId.length > 128
      || !('action' in input)) throw new RoomError(400, '真人操作需要局号、回合标识与动作');
    if (submission.generation !== room.generation || !room.scheduler) throw new RoomError(409, '牌局已变化，请重新查看当前回合');
    try { room.scheduler.submitHumanAction(room.humanControl.seat, submission.decisionId, submission.action); }
    catch (error) { throw new RoomError(409, error instanceof Error ? error.message : '真人操作失败'); }
    return this.getReplay(id);
  }

  updateApiKey(id: string, playerId: string, apiKey: unknown) {
    const room = this.requireRoom(id);
    this.requireOpen(room);
    if (room.started) throw new RoomError(409, 'API keys can only be updated before a game starts');
    if (room.checkController) throw new RoomError(409, 'Wait for the connection check before updating keys');
    const credentials = room.credentials.get(playerId);
    if (!credentials) throw new RoomError(404, 'HTTP Agent not found');
    let normalized: string | undefined;
    try { normalized = normalizeApiKey(apiKey); }
    catch (error) { throw new RoomError(400, error instanceof AgentEndpointError ? error.message : 'Invalid API key'); }
    room.credentials.set(playerId, { ...credentials, apiKey: normalized });
    this.publish(room);
    return this.get(id);
  }

  leave(id: string, playerId: string) {
    const room = this.requireRoom(id);
    this.requireOpen(room);
    const playerIndex = room.players.findIndex((player) => player.id === playerId);
    if (playerIndex < 0) throw new RoomError(404, 'Agent not found');
    if (this.status(room) === 'playing' || this.status(room) === 'finished') return this.close(id, 'agent-left');
    room.checkController?.abort();
    room.unsubscribe?.();
    room.scheduler?.stop();
    room.unsubscribe = undefined;
    room.scheduler = undefined;
    room.accounting = undefined;
    room.players.splice(playerIndex, 1);
    if (room.humanControl?.playerId === playerId) room.humanControl = undefined;
    room.credentials.delete(playerId);
    room.generation += 1;
    this.publish(room);
    return this.get(id);
  }

  async control(id: string, action: string) {
    const room = this.requireRoom(id);
    if (action === 'settle') {
      if (room.scheduler?.getSession().status !== 'finished') throw new RoomError(409, 'The game has not finished');
      this.settleRoom(room, true);
      this.publish(room);
      if (room.accounting?.status !== 'recorded') throw new RoomError(503, 'Settlement could not be recorded; please retry');
      return this.getReplay(id);
    }
    if (action === 'close') { this.close(id, 'manual'); return this.getReplay(id); }
    this.requireOpen(room);
    if (room.checkController && ['start', 'step', 'reset', 'new-game'].includes(action)) throw new RoomError(409, 'Wait for the connection check before starting');
    if (!room.scheduler) throw new RoomError(409, 'Three agents must join before starting');
    if ((action === 'start' || action === 'step') && room.players.some((player) => player.kind === 'deepseek' && !this.deepseekKey(room, player.id))) throw new RoomError(409, 'Configure a DeepSeek API key before starting');
    room.updatedAt = this.now();
    if (action === 'start' || action === 'step') { room.started = true; this.publish(room); }
    if (action === 'start') room.scheduler.start();
    else if (action === 'pause') room.scheduler.pause();
    else if (action === 'step') await room.scheduler.step();
    else if (action === 'reset' || action === 'new-game') {
      if (room.scheduler.getSession().status === 'finished') {
        this.settleRoom(room, true);
        if (room.accounting?.status !== 'recorded') throw new RoomError(503, 'Record the settlement before resetting');
      }
      const previous = room.scheduler;
      this.createGame(room, room.generation + 1, randomSeed(room.seed));
      previous.stop();
      room.generation += 1;
      this.publish(room);
    } else throw new RoomError(400, 'Unknown control action');
    return this.getReplay(id);
  }

  watch(id: string, listener: () => void): () => void {
    const room = this.requireRoom(id);
    this.requireOpen(room);
    room.listeners.add(listener);
    this.publish(room);
    return () => {
      if (room.listeners.delete(listener)) this.publish(room);
    };
  }

  close(id: string, reason = 'manual') {
    const room = this.requireRoom(id);
    if (room.closedAt !== undefined) return this.get(id);
    room.closedAt = this.now();
    room.closeReason = reason;
    room.checkController?.abort();
    room.unsubscribe?.();
    room.unsubscribe = undefined;
    room.scheduler?.stop();
    this.settleRoom(room, true);
    room.credentials.clear();
    room.humanControl = undefined;
    this.publish(room);
    room.listeners.clear();
    return this.get(id);
  }

  sweep(): void {
    const now = this.now();
    for (const room of this.rooms.values()) {
      if (room.closedAt !== undefined) {
        if (room.accounting?.status !== 'error' && now - room.closedAt >= this.closedRetentionMs) this.rooms.delete(room.id);
      } else if (room.listeners.size === 0 && now - room.updatedAt >= this.idleTimeoutMs) {
        this.close(room.id, 'expired');
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.sweepTimer);
    for (const room of this.rooms.values()) this.close(room.id, 'server-shutdown');
    this.rooms.clear();
    if (this.ownsScoreStore) this.scoreStore.close();
  }

  private requireRoom(id: string): RoomRecord {
    const room = this.rooms.get(id);
    if (!room) throw new RoomError(404, 'Room not found');
    return room;
  }

  private requireOpen(room: RoomRecord): void {
    if (room.closedAt !== undefined) throw new RoomError(409, 'Room is closed');
  }

  private status(room: RoomRecord): RoomStatus {
    if (room.closedAt !== undefined) return 'closed';
    if (!room.scheduler) return 'waiting';
    const session = room.scheduler.getSession();
    if (session.status === 'finished') return 'finished';
    return room.started ? 'playing' : 'ready';
  }

  private validateCredentials(input: AgentRegistration): AgentCredentials | undefined {
    if (input.kind === 'deepseek') {
      if (input.api_url !== undefined) throw new RoomError(400, 'DeepSeek uses a fixed official HTTPS endpoint');
      try { return { apiUrl: DEEPSEEK_API_URL, apiKey: normalizeApiKey(input.api_key) }; }
      catch { throw new RoomError(400, 'Invalid DeepSeek API key'); }
    }
    if (input.kind !== 'http') {
      if (input.api_url !== undefined || input.api_key !== undefined) throw new RoomError(400, 'Built-in Agents must not include HTTP credentials');
      return undefined;
    }
    try { return { apiUrl: this.agentPolicy.validate(input.api_url), apiKey: normalizeApiKey(input.api_key) }; }
    catch (error) { throw new RoomError(400, error instanceof AgentEndpointError ? error.message : 'Invalid HTTP Agent configuration'); }
  }

  private deepseekKey(room: RoomRecord, playerId: string): string | undefined { return room.credentials.get(playerId)?.apiKey ?? this.deepseek.apiKey; }

  private createGame(room: RoomRecord, generation = room.generation, seed = room.seed): void {
    const agents = [...room.players].sort((left, right) => left.seat - right.seat).map((player) => player.kind === 'http'
      ? new HttpDecisionAgent(player.name, this.agentPolicy, () => room.credentials.get(player.id), room.id, generation)
      : player.kind === 'deepseek' ? new DeepSeekDecisionAgent(player.name, () => this.deepseekKey(room, player.id), room.id, generation, { ...this.deepseek, skill: player.skill })
      : player.kind === 'human' ? { name: player.name, kind: 'human' as const, decide: () => { throw new Error('真人回合必须由玩家提交操作'); } }
      : this.agentFactory(player, seed));
    const turnTimeoutMs = room.players.some((player) => player.kind === 'deepseek') ? this.deepseekTurnTimeoutMs : this.options.turnTimeoutMs ?? 1500;
    const scheduler = new GameScheduler(agents as [DecisionAgent, DecisionAgent, DecisionAgent], { seed, baseScore: room.baseScore, turnTimeoutMs, stepIntervalMs: this.options.stepIntervalMs ?? 950,
      humanTurnTimeoutMs: this.options.humanTurnTimeoutMs });
    room.unsubscribe?.();
    room.scheduler = scheduler;
    room.seed = seed;
    room.started = false;
    room.accounting = undefined;
    room.unsubscribe = scheduler.subscribe(() => { if (room.scheduler === scheduler) this.publish(room); });
  }

  private publish(room: RoomRecord): void {
    this.settleRoom(room);
    room.updatedAt = this.now();
    room.revision += 1;
    for (const listener of room.listeners) {
      try { listener(); } catch { room.listeners.delete(listener); }
    }
  }

  private settleRoom(room: RoomRecord, retry = false): void {
    if (room.scheduler?.getSession().status !== 'finished' || room.accounting?.status === 'recorded' || (room.accounting && !retry)) return;
    const gameId = gameIdFor(room.id, room.generation);
    try {
      const record = this.scoreStore.record(room.id, room.generation, room.players, room.scheduler.getJournal(), this.now());
      room.accounting = { status: 'recorded', gameId, entries: record.entries };
    } catch { room.accounting = { status: 'error', gameId, entries: [] }; }
  }
}
