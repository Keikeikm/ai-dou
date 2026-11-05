import { randomBytes } from 'node:crypto';
import type { BluffRoomGrant, BluffRoomView } from '../../shared/bluff.js';
import type { DeepSeekOptions } from '../agents/deepseek.js';
import { AgentHttpError, normalizeApiKey } from '../agents/http.js';
import { RoomError } from '../rooms/room-manager.js';
import { MAX_DECISION_TIMEOUT_MS } from '../rooms/scheduler.js';
import { createBluffAgent, type BluffAgent } from './agent.js';
import { applyBluffAction, createBluffGame, observeBluff, type BluffState } from './game.js';
import { DataStore, dataPlayers } from '../data/store.js';
import type { PlayerProfile, BluffStep, EpisodeStatus } from '../../shared/game-data.js';
import type { Card } from '../game/cards.js';

interface Room {
  revealPending: number | null;
  profile: PlayerProfile; initialHands: [Card[], Card[]]; steps: BluffStep[]; startedAt: number; actionStartedAt: number;
  id: string; token: string; state: BluffState; generation: number; agent: BluffAgent;
  thinking: boolean; error: string | null; touched: number; controller?: AbortController;
}

export class BluffRooms {
  private readonly rooms = new Map<string, Room>();
  private readonly sweep = setInterval(() => this.expire(), 60000);
  constructor(private readonly options: DeepSeekOptions = {}, private readonly timeoutMs = 15000, private readonly data?: DataStore) {
    this.sweep.unref();
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_DECISION_TIMEOUT_MS) throw new Error('Invalid bluff decision timeout');
  }
  private expire() {
    for (const [id, room] of this.rooms) if (Date.now() - room.touched > 3600000) {
      try { this.archive(room, 'abandoned'); room.controller?.abort(); this.rooms.delete(id); } catch { /* Retain the in-memory journal for a later persistence retry. */ }
    }
  }
  private key(input: unknown) {
    try { return normalizeApiKey(input === '' ? undefined : input) ?? this.options.apiKey; }
    catch { throw new RoomError(400, 'API key 格式不正确，请检查是否包含空格。'); }
  }
  create(input: Record<string, unknown>): BluffRoomGrant {
    const apiKey = this.key(input.apiKey);
    if (!apiKey) throw new RoomError(400, '请填写 DeepSeek API key，或在服务端配置 DEEPSEEK_API_KEY。');
    this.expire();
    if (this.rooms.size >= 100) throw new RoomError(429, '房间数量已达上限，请关闭不用的房间后重试。');
    const state = createBluffGame();
    let profile: PlayerProfile;
    try { profile = this.data?.profile(input.profileId) ?? { id: 'human_local', name: '我', createdAt: Date.now() }; }
    catch (error) { throw new RoomError(400, (error as Error).message); }
    const room: Room = { id: 'bluff_' + randomBytes(6).toString('hex'), token: randomBytes(32).toString('hex'), state,
      profile, initialHands: structuredClone(state.hands), steps: [], startedAt: Date.now(), actionStartedAt: Date.now(),
      generation: 1, agent: createBluffAgent({ ...this.options, apiKey }), thinking: false, error: null, touched: Date.now(), revealPending: null };
    this.rooms.set(room.id, room);
    return { room: this.view(room), token: room.token };
  }
  private authorized(id: string, token: string | undefined) {
    const room = this.rooms.get(id);
    if (!room) throw new RoomError(404, '吹牛房间不存在或已过期，请重新开局。');
    if (!token || token !== room.token) throw new RoomError(403, '无法恢复你的席位，请在原来的浏览器标签页继续，或重新开局。');
    room.touched = Date.now();
    return room;
  }
  private view(room: Room): BluffRoomView {
    return { ...observeBluff(room.state, 0), id: room.id, generation: room.generation, thinking: room.thinking,
      error: room.error, model: this.options.model ?? 'deepseek-flash', revealPending: room.revealPending };
  }
  get(id: string, token: string | undefined) { return this.view(this.authorized(id, token)); }
  control(id: string, token: string | undefined, input: Record<string, unknown>): BluffRoomView {
    const room = this.authorized(id, token);
    if (input.revision !== room.state.revision || input.generation !== room.generation) throw new RoomError(409, '牌局已更新，请重新加载后再行动。');
    if (room.thinking) throw new RoomError(409, '鲸鱼娘正在思考，请稍候。');
    if (input.type === 'ack-reveal') {
      if (room.revealPending === null || input.revealRevision !== room.revealPending) throw new RoomError(409, '这次翻牌已确认或已过期，请重新加载。');
      room.revealPending = null;
      room.actionStartedAt = Date.now();
      if (room.state.phase !== 'finished' && room.state.turn === 1) void this.advance(room);
      return this.view(room);
    }
    if (room.revealPending !== null) throw new RoomError(409, '请先确认翻牌结果，再进入下一手。');
    if (input.type === 'restart') {
      if (room.state.phase !== 'finished') throw new RoomError(409, '请先完成本局，或返回大厅重新开局。');
      room.state = createBluffGame(); room.generation += 1; room.error = null; room.revealPending = null;
      room.initialHands = structuredClone(room.state.hands); room.steps = []; room.startedAt = Date.now(); room.actionStartedAt = Date.now();
    } else if (input.type === 'retry') {
      if (!room.error || room.state.turn !== 1 || room.state.phase === 'finished') throw new RoomError(409, '当前没有需要重试的模型动作。');
      if (input.apiKey !== undefined) {
        const apiKey = this.key(input.apiKey);
        if (!apiKey) throw new RoomError(400, '请填写有效的 API key。');
        room.agent = createBluffAgent({ ...this.options, apiKey });
      }
      room.error = null;
    } else {
      try { this.recordAction(room, 0, input.action); }
      catch (error) { if (error instanceof RoomError) throw error; throw new RoomError(400, error instanceof Error ? error.message : '无效动作。'); }
    }
    if (room.revealPending === null && room.state.phase !== 'finished' && room.state.turn === 1) void this.advance(room);
    return this.view(room);
  }
  close(id: string, token: string | undefined) {
    const room = this.authorized(id, token); this.archive(room, 'abandoned'); room.controller?.abort(); this.rooms.delete(id);
  }
  private async advance(room: Room): Promise<void> {
    room.thinking = true;
    const controller = new AbortController();
    room.controller = controller;
    try {
      // A response and a play are separate decisions; stop as soon as the human must act.
      while (room.revealPending === null && room.state.turn === 1 && room.state.phase !== 'finished') {
        room.actionStartedAt = Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancel: (() => void) | undefined;
        try {
          const action = await Promise.race([
            room.agent.decide(observeBluff(room.state, 1), controller.signal),
            new Promise<never>((_, reject) => {
              cancel = () => reject(new Error('cancelled'));
              controller.signal.addEventListener('abort', cancel, { once: true });
              timer = setTimeout(() => { reject(new Error('timeout')); controller.abort(); }, this.timeoutMs);
            }),
          ]);
          controller.signal.throwIfAborted();
          try { this.recordAction(room, 1, action); } catch (error) { if (error instanceof RoomError) throw error; throw new Error('invalid_response'); }
        } finally {
          clearTimeout(timer);
          if (cancel) controller.signal.removeEventListener('abort', cancel);
        }
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
    if (!this.data || !room.steps.length) return;
    try {
      this.data.save({ id: room.id + '_' + room.generation, roomId: room.id, generation: room.generation, startedAt: room.startedAt,
        status: room.state.phase === 'finished' ? 'finished' : status,
        players: dataPlayers([{ seat: 0, name: room.profile.name, kind: 'human' }, { seat: 1, name: '鲸鱼娘', kind: 'deepseek' }], room.profile, this.options.model ?? 'deepseek-flash'),
        raw: { game: 'bluff', rulesVersion: room.state.rulesVersion, initialHands: room.initialHands, steps: room.steps } });
    } catch { throw new RoomError(503, '牌局数据保存失败，动作未提交。请检查磁盘后重试。'); }
  }
  private recordAction(room: Room, seat: 0 | 1, input: unknown) {
    const next = structuredClone(room.state);
    applyBluffAction(next, seat, input);
    const event = next.history.at(-1)!;
    const action = event.type === 'play' ? { type: 'play' as const, cards: next.pending!.cards.map((card) => card.id) } : { type: event.type };
    const step: BluffStep = { seat, action, source: seat === 0 ? 'human' : 'model', at: Date.now(), durationMs: Math.max(0, Date.now() - room.actionStartedAt) };
    const updated = { ...room, state: next, steps: [...room.steps, step] };
    this.archive(updated, 'active');
    room.state = next; room.steps = updated.steps; room.actionStartedAt = Date.now();
    if (event.type === 'challenge') room.revealPending = event.sequence;
  }
  dispose() { clearInterval(this.sweep); for (const room of this.rooms.values()) { try { this.archive(room, 'interrupted'); } catch { /* Every accepted action was already committed; startup recovers its active row. */ } finally { room.controller?.abort(); } } this.rooms.clear(); }
}
