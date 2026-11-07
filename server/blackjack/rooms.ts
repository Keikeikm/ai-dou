import { randomBytes } from 'node:crypto';
import type { BlackjackRoomGrant, BlackjackRoomView } from '../../shared/blackjack.js';
import type { BlackjackStep, EpisodeStatus, PlayerProfile } from '../../shared/game-data.js';
import type { DeepSeekOptions } from '../agents/deepseek.js';
import { AgentHttpError, normalizeApiKey } from '../agents/http.js';
import { DataStore, dataPlayers } from '../data/store.js';
import { RoomError } from '../rooms/room-manager.js';
import { MAX_DECISION_TIMEOUT_MS } from '../rooms/scheduler.js';
import { createBlackjackAgent, type BlackjackAgent } from './agent.js';
import { applyBlackjackAction, createBlackjackGame, observeBlackjack, type BlackjackState } from './game.js';

interface Room {
  id: string; token: string; generation: number; state: BlackjackState; profile: PlayerProfile;
  agent: BlackjackAgent; steps: BlackjackStep[]; startedAt: number; actionStartedAt: number; touched: number;
  thinking: boolean; error: string | null; controller?: AbortController;
}

export class BlackjackRooms {
  private readonly rooms = new Map<string, Room>();
  private readonly sweep = setInterval(() => this.expire(), 60000);
  constructor(private readonly options: DeepSeekOptions = {}, private readonly timeoutMs = 15000, private readonly data?: DataStore) {
    this.sweep.unref();
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_DECISION_TIMEOUT_MS) throw new Error('Invalid blackjack decision timeout');
  }
  private expire() {
    for (const [id, room] of this.rooms) if (Date.now() - room.touched > 3600000) {
      try { this.archive(room, 'abandoned'); room.controller?.abort(); this.rooms.delete(id); } catch { /* Retain journals until persistence can be retried. */ }
    }
  }
  private key(input: unknown) {
    try { return normalizeApiKey(input === '' ? undefined : input) ?? this.options.apiKey; }
    catch { throw new RoomError(400, 'API key 格式不正确，请检查是否包含空格。'); }
  }
  create(input: Record<string, unknown>): BlackjackRoomGrant {
    const apiKey = this.key(input.apiKey);
    if (!apiKey) throw new RoomError(400, '请填写 DeepSeek API key，或在服务端配置 DEEPSEEK_API_KEY。');
    this.expire();
    if (this.rooms.size >= 100) throw new RoomError(429, '房间数量已达上限，请关闭不用的房间后重试。');
    let profile: PlayerProfile;
    try { profile = this.data?.profile(input.profileId) ?? { id: 'human_local', name: '我', createdAt: Date.now() }; }
    catch (error) { throw new RoomError(400, (error as Error).message); }
    const now = Date.now();
    const room: Room = { id: 'blackjack_' + randomBytes(6).toString('hex'), token: randomBytes(32).toString('hex'), generation: 1,
      state: createBlackjackGame(), profile, agent: createBlackjackAgent({ ...this.options, apiKey }), steps: [], startedAt: now,
      actionStartedAt: now, touched: now, thinking: false, error: null };
    // A natural can settle immediately without a decision; retain these episodes too.
    this.archive(room, 'active');
    this.rooms.set(room.id, room);
    return { room: this.view(room), token: room.token };
  }
  private authorized(id: string, token: string | undefined) {
    const room = this.rooms.get(id);
    if (!room) throw new RoomError(404, '21 点房间不存在或已过期，请重新开局。');
    if (!token || token !== room.token) throw new RoomError(403, '无法恢复你的席位，请在原来的浏览器标签页继续，或重新开局。');
    room.touched = Date.now();
    return room;
  }
  private view(room: Room): BlackjackRoomView {
    return { ...observeBlackjack(room.state), id: room.id, generation: room.generation, thinking: room.thinking,
      error: room.error, model: this.options.model ?? 'deepseek-flash' };
  }
  get(id: string, token: string | undefined) { return this.view(this.authorized(id, token)); }
  control(id: string, token: string | undefined, input: Record<string, unknown>): BlackjackRoomView {
    const room = this.authorized(id, token);
    if (input.revision !== room.state.revision || input.generation !== room.generation) throw new RoomError(409, '牌局已更新，请重新加载后再行动。');
    if (room.thinking) throw new RoomError(409, '鲸鱼娘正在思考，请稍候。');
    if (input.type === 'restart') {
      if (room.state.phase !== 'finished') throw new RoomError(409, '请先完成本局，或返回大厅重新开局。');
      const now = Date.now();
      const next = { ...room, state: createBlackjackGame(), generation: room.generation + 1, steps: [], startedAt: now, actionStartedAt: now, error: null };
      this.archive(next, 'active');
      Object.assign(room, next);
    } else if (input.type === 'retry') {
      if (!room.error || room.state.turn !== 1 || room.state.phase === 'finished') throw new RoomError(409, '当前没有需要重试的模型动作。');
      if (input.apiKey !== undefined) {
        const apiKey = this.key(input.apiKey);
        if (!apiKey) throw new RoomError(400, '请填写有效的 API key。');
        room.agent = createBlackjackAgent({ ...this.options, apiKey });
      }
      room.error = null;
    } else if (input.type !== undefined) throw new RoomError(400, '无效控制操作。');
    else {
      try { this.recordAction(room, 0, input.action); }
      catch (error) { if (error instanceof RoomError) throw error; throw new RoomError(400, error instanceof Error ? error.message : '无效动作。'); }
    }
    if (room.state.phase !== 'finished' && room.state.turn === 1) void this.advance(room);
    return this.view(room);
  }
  private recordAction(room: Room, seat: 0 | 1, input: unknown) {
    const next = structuredClone(room.state);
    applyBlackjackAction(next, seat, input);
    const event = next.history.at(-1)!;
    const step: BlackjackStep = { seat, action: { type: event.type }, source: seat === 0 ? 'human' : 'model', at: Date.now(), durationMs: Math.max(0, Date.now() - room.actionStartedAt) };
    const updated = { ...room, state: next, steps: [...room.steps, step] };
    this.archive(updated, 'active');
    room.state = next; room.steps = updated.steps; room.actionStartedAt = Date.now();
  }
  private async advance(room: Room): Promise<void> {
    room.thinking = true;
    const controller = new AbortController(); room.controller = controller;
    try {
      while (room.state.turn === 1 && room.state.phase !== 'finished') {
        room.actionStartedAt = Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancel: (() => void) | undefined;
        try {
          const action = await Promise.race([
            room.agent.decide(observeBlackjack(room.state, 1), controller.signal),
            new Promise<never>((_, reject) => {
              cancel = () => reject(new Error('cancelled'));
              controller.signal.addEventListener('abort', cancel, { once: true });
              timer = setTimeout(() => { reject(new Error('timeout')); controller.abort(); }, this.timeoutMs);
            }),
          ]);
          controller.signal.throwIfAborted();
          try { this.recordAction(room, 1, action); } catch (error) { if (error instanceof RoomError) throw error; throw new Error('invalid_response'); }
        } finally { clearTimeout(timer); if (cancel) controller.signal.removeEventListener('abort', cancel); }
      }
    } catch (error) {
      room.error = error instanceof RoomError ? error.message : error instanceof AgentHttpError
        ? error.statusCode === 401 || error.statusCode === 403 ? 'DeepSeek 密钥验证失败，请更换密钥后重试。'
          : error.statusCode === 402 ? 'DeepSeek 余额不足，请充值后重试。'
            : error.statusCode === 429 ? 'DeepSeek 请求限流，请稍后重试。' : 'DeepSeek 服务暂时不可用，请稍后重试。'
        : error instanceof Error && error.message === 'timeout' ? '鲸鱼娘思考超时，请重试这一动作。'
          : error instanceof Error && error.message === 'invalid_response' ? '模型返回的动作不合法，牌局已暂停，请重试。'
            : '无法连接 DeepSeek，牌局已暂停，请检查网络后重试。';
    } finally { room.thinking = false; delete room.controller; }
  }
  private archive(room: Room, status: EpisodeStatus) {
    if (!this.data) return;
    try {
      this.data.save({ id: room.id + '_' + room.generation, roomId: room.id, generation: room.generation, startedAt: room.startedAt,
        status: room.state.phase === 'finished' ? 'finished' : status,
        players: dataPlayers([{ seat: 0, name: room.profile.name, kind: 'human' }, { seat: 1, name: '鲸鱼娘', kind: 'deepseek', skill: 'blackjack-duel' }], room.profile, this.options.model ?? 'deepseek-flash'),
        raw: { game: 'blackjack', rulesVersion: room.state.rulesVersion, deck: room.state.initialDeck, steps: room.steps } });
    } catch { throw new RoomError(503, '牌局数据保存失败，动作未提交。请检查磁盘后重试。'); }
  }
  close(id: string, token: string | undefined) {
    const room = this.authorized(id, token); this.archive(room, 'abandoned'); room.controller?.abort(); this.rooms.delete(id);
  }
  dispose() {
    clearInterval(this.sweep);
    for (const room of this.rooms.values()) { try { this.archive(room, 'interrupted'); } catch { /* Accepted actions were already persisted. */ } finally { room.controller?.abort(); } }
    this.rooms.clear();
  }
}
