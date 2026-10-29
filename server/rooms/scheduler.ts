import { randomInt, randomUUID } from 'node:crypto';
import { rankValue } from '../game/cards.js';
import { AgentProtocolError } from '../agents/protocol.js';
import type { BotAction } from '../agents/bots.js';
import { applyGameAction } from '../game/actions.js';
import { createGame, type GamePhase, type GameState } from '../game/game.js';
import { captureSnapshot, type GameSnapshot } from '../game/snapshots.js';
import { validateBaseScore, type Settlement } from '../game/scoring.js';
import type { SkillMetadata } from '../../shared/strategy-skills.js';
import { parseHumanAction } from '../agents/human.js';

export interface DecisionContext {
  readonly signal: AbortSignal;
  readonly sequence: number;
  readonly deadline: number;
  readonly recordModelResponse?: (response: ModelResponse) => void;
}

export interface ModelResponse {
  readonly provider: 'deepseek';
  readonly model: string;
  readonly status: 'accepted' | 'invalid' | 'error';
  readonly durationMs: number;
  readonly strategy?: SkillMetadata;
  readonly requestId?: string;
  readonly content?: string;
  readonly contentTruncated?: boolean;
  readonly finishReason?: string;
  readonly actionIndex?: number;
  readonly httpStatus?: number;
  readonly error?: 'dns_failed' | 'tls_failed' | 'connection_failed' | 'response_failed' | 'cancelled' | 'invalid_response';
  readonly usage?: { readonly promptTokens?: number; readonly completionTokens?: number; readonly totalTokens?: number; readonly cacheHitTokens?: number; readonly cacheMissTokens?: number };
}

export interface DecisionAgent {
  readonly name: string;
  readonly kind?: 'bot' | 'http' | 'model' | 'human';
  decide(state: GameState, context: DecisionContext): BotAction | Promise<BotAction>;
}

export type SchedulerStatus = 'idle' | 'running' | 'paused' | 'finished' | 'stopped';
export type FallbackReason = 'timeout' | 'error' | 'invalid';
export const MAX_DECISION_TIMEOUT_MS = 300000;

export interface DecisionProgress {
  readonly sequence: number;
  readonly seat: number;
  readonly phase: GamePhase;
  readonly startedAt: number;
  readonly deadline: number;
  readonly kind?: 'human';
  readonly id?: string;
}

export interface TurnRecord {
  readonly sequence: number;
  readonly seat: number;
  readonly phase: GamePhase;
  readonly action: BotAction;
  readonly source: 'agent' | 'fallback' | 'human';
  readonly decisionKind?: 'bot' | 'http' | 'model' | 'human' | undefined;
  readonly reason?: FallbackReason | undefined;
  readonly detail?: string | undefined;
  readonly modelResponse?: ModelResponse;
}

export interface GameJournal {
  readonly version: 1;
  readonly seed: number;
  readonly players: readonly string[];
  readonly status: SchedulerStatus;
  readonly turns: readonly TurnRecord[];
  readonly baseScore?: number;
  readonly settlement?: Settlement;
}

export interface SchedulerOptions {
  readonly seed?: number;
  readonly turnTimeoutMs?: number;
  readonly stepIntervalMs?: number;
  readonly baseScore?: number;
  readonly humanTurnTimeoutMs?: number | undefined;
}

class DecisionTimeout extends Error {}
class DecisionCancelled extends Error {}

function fallbackAction(state: GameState): BotAction {
  if (state.phase === 'calling') return { type: 'call', score: 0 };
  if (state.lastPlay) return { type: 'pass' };
  const card = [...state.hands[state.currentSeat]].sort((left, right) => rankValue(left.rank) - rankValue(right.rank))[0];
  return { type: 'play', cards: [card] };
}

async function decideBeforeDeadline(agent: DecisionAgent, state: GameState, controller: AbortController, progress: DecisionProgress, recordModelResponse: (response: ModelResponse) => void): Promise<BotAction> {
  const { deadline, sequence } = progress;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => agent.decide(structuredClone(state), { signal: controller.signal, sequence, deadline, recordModelResponse })),
      new Promise<never>((_, reject) => {
        cancel = () => reject(new DecisionCancelled('Decision cancelled'));
        controller.signal.addEventListener('abort', cancel, { once: true });
        timeout = setTimeout(() => {
          reject(new DecisionTimeout('Decision timed out'));
          controller.abort();
        }, Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    if (cancel) controller.signal.removeEventListener('abort', cancel);
  }
}

export function replayJournal(journal: GameJournal): GameSnapshot[] {
  if (journal.version !== 1 || !Number.isInteger(journal.seed) || journal.seed < 0 || journal.seed > 0xffffffff || journal.players.length !== 3) {
    throw new Error('Invalid game journal');
  }
  let state = createGame(journal.seed);
  const baseScore = validateBaseScore(journal.baseScore ?? 1);
  const snapshots = [captureSnapshot(state, journal.players, baseScore)];
  for (const [index, turn] of journal.turns.entries()) {
    if (turn.sequence !== index + 1 || turn.seat !== state.currentSeat || turn.phase !== state.phase) {
      throw new Error('Journal turn is out of order');
    }
    state = applyGameAction(state, turn.seat, turn.action);
    snapshots.push(captureSnapshot(state, journal.players, baseScore));
  }
  if ((journal.status === 'finished') !== (state.phase === 'finished')) throw new Error('Journal result is incomplete');
  if (journal.settlement !== undefined && JSON.stringify(journal.settlement) !== JSON.stringify(snapshots.at(-1)?.settlement)) throw new Error('Journal settlement does not match the game');
  return snapshots;
}

export class GameScheduler {
  readonly seed: number;
  readonly turnTimeoutMs: number;
  readonly stepIntervalMs: number;
  readonly baseScore: number;
  readonly humanTurnTimeoutMs: number;
  private state: GameState;
  private status: SchedulerStatus = 'idle';
  private snapshots: GameSnapshot[];
  private turns: TurnRecord[] = [];
  private revision = 0;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private humanTimer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private pending: Promise<void> | undefined;
  private decision: DecisionProgress | undefined;

  constructor(private readonly agents: readonly [DecisionAgent, DecisionAgent, DecisionAgent], options: SchedulerOptions = {}) {
    this.seed = options.seed ?? randomInt(0, 0x100000000);
    this.turnTimeoutMs = options.turnTimeoutMs ?? 1500;
    this.stepIntervalMs = options.stepIntervalMs ?? 950;
    this.baseScore = validateBaseScore(options.baseScore ?? 1);
    this.humanTurnTimeoutMs = options.humanTurnTimeoutMs ?? 60000;
    if (!Number.isInteger(this.seed) || this.seed < 0 || this.seed > 0xffffffff) throw new Error('Invalid seed');
    if (!Number.isInteger(this.turnTimeoutMs) || this.turnTimeoutMs < 1 || this.turnTimeoutMs > MAX_DECISION_TIMEOUT_MS) throw new Error('Invalid decision timeout');
    if (!Number.isInteger(this.stepIntervalMs) || this.stepIntervalMs < 0 || this.stepIntervalMs > 60000) throw new Error('Invalid step interval');
    if (!Number.isInteger(this.humanTurnTimeoutMs) || this.humanTurnTimeoutMs < 1 || this.humanTurnTimeoutMs > MAX_DECISION_TIMEOUT_MS) throw new Error('Invalid human decision timeout');
    this.state = createGame(this.seed);
    this.snapshots = [captureSnapshot(this.state, this.agents.map((agent) => agent.name), this.baseScore)];
  }

  getSession() {
    return { status: this.status, turnTimeoutMs: this.turnTimeoutMs, stepIntervalMs: this.stepIntervalMs, turnCount: this.turns.length,
      serverTime: Date.now(), decision: this.decision ? { ...this.decision } : null };
  }

  getReplay() {
    return structuredClone({
      seed: this.seed,
      revision: this.revision,
      snapshots: this.snapshots,
      session: this.getSession(),
      turns: this.turns,
    });
  }

  getJournal(): GameJournal {
    return structuredClone({ version: 1, seed: this.seed, baseScore: this.baseScore, players: this.agents.map((agent) => agent.name), status: this.status, turns: this.turns,
      ...(this.snapshots.at(-1)?.settlement ? { settlement: this.snapshots.at(-1)!.settlement! } : {}) });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.status === 'finished' || this.status === 'stopped' || this.status === 'running') return;
    this.status = 'running';
    this.notify();
    if (this.pending) void this.pending.then(() => this.schedule(0));
    else this.schedule(0);
  }

  pause(): void {
    if (this.status === 'finished' || this.status === 'stopped') return;
    clearTimeout(this.timer);
    clearTimeout(this.humanTimer);
    this.controller?.abort();
    this.decision = undefined;
    this.status = 'paused';
    this.notify();
  }

  stop(): void {
    clearTimeout(this.timer);
    clearTimeout(this.humanTimer);
    this.controller?.abort();
    this.decision = undefined;
    if (this.status !== 'finished') this.status = 'stopped';
    this.notify();
  }

  step(): Promise<void> {
    clearTimeout(this.timer);
    if (this.status !== 'finished' && this.status !== 'stopped') this.status = 'paused';
    if (this.pending) {
      return this.controller?.signal.aborted ? this.pending.then(() => this.step()) : this.pending;
    }
    if (this.status === 'finished' || this.status === 'stopped') return Promise.resolve();
    return this.performTurn();
  }

  private notify(): void {
    this.revision += 1;
    for (const listener of this.listeners) {
      try { listener(); } catch { this.listeners.delete(listener); }
    }
  }

  private schedule(delay: number): void {
    if (this.status !== 'running' || this.decision?.kind === 'human') return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.performTurn(); }, delay);
  }

  private performTurn(): Promise<void> {
    if (this.agents[this.state.currentSeat].kind === 'human') {
      this.waitForHuman();
      return Promise.resolve();
    }
    const controller = new AbortController();
    this.controller = controller;
    this.pending = this.executeTurn(controller).finally(() => {
      this.controller = undefined;
      this.pending = undefined;
      if (this.decision) { this.decision = undefined; this.notify(); }
      this.schedule(this.stepIntervalMs);
    });
    return this.pending;
  }

  submitHumanAction(seat: number, decisionId: string, input: unknown): void {
    if (this.status === 'finished' || this.status === 'stopped' || this.agents[seat]?.kind !== 'human' || seat !== this.state.currentSeat
      || this.decision?.kind !== 'human' || this.decision.id !== decisionId) throw new Error('当前不是你的操作回合，或该回合已过期');
    if (Date.now() >= this.decision.deadline) throw new Error('本回合已超时，请等待服务端托管');
    const before = this.state;
    const action = parseHumanAction(input, before.hands[seat]);
    let next: GameState;
    try { next = applyGameAction(before, seat, action); }
    catch { throw new Error('所选牌型不合法、无法压过桌面牌，或当前阶段不允许该操作'); }
    clearTimeout(this.humanTimer);
    this.state = next;
    this.recordTurn(before, action, 'human');
    this.schedule(this.stepIntervalMs);
  }

  private waitForHuman(): void {
    if (this.decision?.kind === 'human') return;
    const before = this.state;
    const startedAt = Date.now();
    const progress: DecisionProgress = { id: randomUUID(), kind: 'human', sequence: this.turns.length + 1, seat: before.currentSeat,
      phase: before.phase, startedAt, deadline: startedAt + this.humanTurnTimeoutMs };
    this.decision = progress;
    this.humanTimer = setTimeout(() => {
      if (this.decision !== progress) return;
      const action = fallbackAction(before);
      this.state = applyGameAction(before, before.currentSeat, action);
      this.recordTurn(before, action, 'fallback', 'timeout');
      this.schedule(this.stepIntervalMs);
    }, this.humanTurnTimeoutMs);
    this.humanTimer.unref?.();
    this.notify();
  }

  private async executeTurn(controller: AbortController): Promise<void> {
    const before = this.state;
    const seat = before.currentSeat;
    const startedAt = Date.now();
    const progress = { sequence: this.turns.length + 1, seat, phase: before.phase, startedAt, deadline: startedAt + this.turnTimeoutMs };
    this.decision = progress;
    this.notify();
    let action: BotAction;
    let reason: FallbackReason | undefined;
    let detail: string | undefined;
    let modelResponse: ModelResponse | undefined;
    try {
      action = await decideBeforeDeadline(this.agents[seat], before, controller, progress, (response) => {
        if (!controller.signal.aborted && this.agents[seat].kind === 'model') modelResponse = structuredClone(response);
      });
    } catch (error) {
      if (error instanceof DecisionCancelled) return;
      reason = error instanceof DecisionTimeout ? 'timeout' : error instanceof AgentProtocolError ? 'invalid' : 'error';
      detail = error instanceof Error ? error.message.slice(0, 200) : 'Decision failed';
      action = fallbackAction(before);
    }
    if (controller.signal.aborted && reason !== 'timeout') return;
    try {
      this.state = applyGameAction(before, seat, action);
    } catch (error) {
      reason = 'invalid';
      detail = error instanceof Error ? error.message.slice(0, 200) : 'Invalid decision';
      action = fallbackAction(before);
      this.state = applyGameAction(before, seat, action);
    }
    this.recordTurn(before, action, reason ? 'fallback' : 'agent', reason, detail, modelResponse);
  }

  private recordTurn(before: GameState, action: BotAction, source: TurnRecord['source'], reason?: FallbackReason, detail?: string, modelResponse?: ModelResponse): void {
    const seat = before.currentSeat;
    const normalized = action.type === 'play' ? { type: 'play' as const, cards: this.state.lastPlay!.combination.cards } : action;
    this.turns.push(structuredClone({ sequence: this.turns.length + 1, seat, phase: before.phase, action: normalized, source, decisionKind: this.agents[seat].kind, reason, detail,
      ...(modelResponse ? { modelResponse } : {}) }));
    this.snapshots.push(captureSnapshot(this.state, this.agents.map((agent) => agent.name), this.baseScore));
    this.decision = undefined;
    if (this.state.phase === 'finished') this.status = 'finished';
    this.notify();
  }
}
