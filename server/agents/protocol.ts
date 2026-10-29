import { createDeck, type Card } from '../game/cards.js';
import type { BotAction } from './bots.js';
import type { CallScore, GameState } from '../game/game.js';

export type AgentAction = 'call_1' | 'call_2' | 'call_3' | 'pass' | 'play';

export interface AgentResponse {
  readonly protocol_version: 1;
  readonly request_id: string;
  readonly action: AgentAction;
  readonly cards?: readonly string[];
}

export interface AgentRequest {
  readonly protocol_version: 1;
  readonly request_id: string;
  readonly room_id: string;
  readonly generation: number;
  readonly round: number;
  readonly seat: number;
  readonly role: 'landlord' | 'farmer' | null;
  readonly hand_cards: readonly string[];
  readonly visible_cards: Readonly<Record<'seat_0' | 'seat_1' | 'seat_2', number>>;
  readonly bottom_cards: readonly string[];
  readonly history: readonly { readonly seat: number; readonly action: 'call' | 'play' | 'pass'; readonly cards: readonly string[]; readonly score?: number }[];
  readonly last_play: { readonly seat: number; readonly cards: readonly string[] } | null;
  readonly call_score: number;
  readonly action_type: 'call' | 'play';
  readonly deadline_at: string;
}

export class AgentProtocolError extends Error {}

const deck = new Map(createDeck().map((card) => [card.id, card]));
const actions: readonly string[] = ['call_1', 'call_2', 'call_3', 'pass', 'play'];

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cardIds(value: unknown, min = 0, max = 20): value is string[] {
  return Array.isArray(value) && value.length >= min && value.length <= max &&
    value.every((card) => typeof card === 'string' && deck.has(card)) && new Set(value).size === value.length;
}

function seat(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 2;
}

export function createAgentRequest(state: GameState, context: { roomId: string; generation: number; round: number; deadline: number }): AgentRequest {
  if (state.phase === 'finished') throw new AgentProtocolError('Cannot request a decision after the game ends');
  return {
    protocol_version: 1,
    request_id: context.roomId + ':' + context.generation + ':' + context.round,
    room_id: context.roomId,
    generation: context.generation,
    round: context.round,
    seat: state.currentSeat,
    role: state.landlord < 0 ? null : state.landlord === state.currentSeat ? 'landlord' : 'farmer',
    hand_cards: state.hands[state.currentSeat].map((card) => card.id),
    visible_cards: { seat_0: state.hands[0].length, seat_1: state.hands[1].length, seat_2: state.hands[2].length },
    bottom_cards: state.landlord < 0 ? [] : state.bottomCards.map((card) => card.id),
    history: state.logs.flatMap((entry) => {
      if (entry.action !== 'call' && entry.action !== 'play' && entry.action !== 'pass') return [];
      return [{ seat: entry.seat, action: entry.action, cards: entry.cards.map((card) => card.id), ...(entry.action === 'call' ? { score: entry.score! } : {}) }];
    }),
    last_play: state.lastPlay ? { seat: state.lastPlay.seat, cards: state.lastPlay.combination.cards.map((card) => card.id) } : null,
    call_score: state.callScore,
    action_type: state.phase === 'calling' ? 'call' : 'play',
    deadline_at: new Date(context.deadline).toISOString(),
  };
}

export function parseAgentRequest(value: unknown): AgentRequest {
  const fields = ['protocol_version', 'request_id', 'room_id', 'generation', 'round', 'seat', 'role', 'hand_cards', 'visible_cards', 'bottom_cards', 'history', 'last_play', 'call_score', 'action_type', 'deadline_at'];
  if (!object(value) || Object.keys(value).length !== fields.length || !fields.every((field) => field in value) ||
    value.protocol_version !== 1 || typeof value.room_id !== 'string' || !/^room_[a-f0-9]{12}$/.test(value.room_id) ||
    !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 ||
    !Number.isSafeInteger(value.round) || Number(value.round) < 1 ||
    value.request_id !== value.room_id + ':' + value.generation + ':' + value.round || !seat(value.seat) ||
    ![null, 'landlord', 'farmer'].includes(value.role as string | null) || !cardIds(value.hand_cards, 1) ||
    !cardIds(value.bottom_cards, 0, 3) || ![1, 2, 3].includes(Number(value.call_score)) || typeof value.call_score !== 'number' ||
    !['call', 'play'].includes(value.action_type as string) || typeof value.deadline_at !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.deadline_at) || !Number.isFinite(Date.parse(value.deadline_at)) ||
    new Date(value.deadline_at).toISOString() !== value.deadline_at) {
    throw new AgentProtocolError('Invalid Agent request');
  }
  const counts = value.visible_cards;
  if (!object(counts) || Object.keys(counts).length !== 3 || !['seat_0', 'seat_1', 'seat_2'].every((key) =>
    Number.isInteger(counts[key]) && Number(counts[key]) >= 0 && Number(counts[key]) <= 20) ||
    counts['seat_' + value.seat] !== value.hand_cards.length) throw new AgentProtocolError('Invalid visible card counts');
  if (!Array.isArray(value.history) || value.history.length > 1024 || !value.history.every((entry: unknown) => {
    if (!object(entry) || !seat(entry.seat) || !['call', 'play', 'pass'].includes(entry.action as string) || !cardIds(entry.cards)) return false;
    const fields = entry.action === 'call' ? ['seat', 'action', 'cards', 'score'] : ['seat', 'action', 'cards'];
    if (Object.keys(entry).length !== fields.length || !fields.every((field) => field in entry)) return false;
    return entry.action === 'play' ? entry.cards.length > 0 : entry.cards.length === 0 && (entry.action !== 'call' || [0, 1, 2, 3].includes(entry.score as number));
  })) throw new AgentProtocolError('Invalid public history');
  if (value.last_play !== null && (!object(value.last_play) || Object.keys(value.last_play).length !== 2 || !seat(value.last_play.seat) || !cardIds(value.last_play.cards, 1))) {
    throw new AgentProtocolError('Invalid last play');
  }
  if (value.action_type === 'call' && (value.role !== null || value.bottom_cards.length !== 0 || value.last_play !== null)) throw new AgentProtocolError('Invalid calling context');
  if (value.action_type === 'play' && (value.role === null || value.bottom_cards.length !== 3)) throw new AgentProtocolError('Invalid playing context');
  return value as unknown as AgentRequest;
}

export function parseAgentResponse(value: unknown, request: AgentRequest, state: GameState): BotAction {
  if (!object(value) || value.protocol_version !== 1 || value.request_id !== request.request_id ||
    !actions.includes(value.action as string) || Object.keys(value).some((field) => !['protocol_version', 'request_id', 'action', 'cards'].includes(field))) {
    throw new AgentProtocolError('Invalid Agent response envelope or request id');
  }
  if (value.action === 'play') {
    if (request.action_type !== 'play' || !cardIds(value.cards, 1)) throw new AgentProtocolError('Invalid Agent play response');
    const cards = value.cards.map((id) => state.hands[state.currentSeat].find((card) => card.id === id));
    if (cards.some((card) => !card)) throw new AgentProtocolError('Agent selected a card outside its hand');
    return { type: 'play', cards: cards as Card[] };
  }
  if (value.cards !== undefined && (!Array.isArray(value.cards) || value.cards.length !== 0)) throw new AgentProtocolError('Non-play actions must not contain cards');
  if (value.action === 'pass') return request.action_type === 'call' ? { type: 'call', score: 0 } : { type: 'pass' };
  if (request.action_type !== 'call') throw new AgentProtocolError('Cannot call during play');
  return { type: 'call', score: Number((value.action as string).slice(-1)) as CallScore };
}

export function responseForAction(request: AgentRequest, action: BotAction): AgentResponse {
  return { protocol_version: 1, request_id: request.request_id, action: action.type === 'call' ? action.score === 0 ? 'pass' : ('call_' + action.score) as AgentAction : action.type,
    ...(action.type === 'play' ? { cards: action.cards.map((card) => card.id) } : {}) };
}
