import type { Card } from '../game/cards.js';
import type { BotAction } from './bots.js';

export function parseHumanAction(value: unknown, hand: readonly Card[]): BotAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的真人操作');
  const action = value as Record<string, unknown>;
  if (action.type === 'pass' && Object.keys(action).length === 1) return { type: 'pass' };
  if (action.type === 'call' && Object.keys(action).length === 2 && Number.isInteger(action.score) && [0, 1, 2, 3].includes(Number(action.score))) {
    return { type: 'call', score: action.score as 0 | 1 | 2 | 3 };
  }
  if (action.type !== 'play' || Object.keys(action).length !== 2 || !Array.isArray(action.cards) || !action.cards.length || action.cards.length > 20
    || new Set(action.cards).size !== action.cards.length || action.cards.some((id) => typeof id !== 'string')) throw new Error('请选择有效的手牌，不可重复选牌');
  const cards = action.cards.map((id) => hand.find((card) => card.id === id));
  if (cards.some((card) => !card)) throw new Error('只能打出自己持有的牌');
  return { type: 'play', cards: cards as Card[] };
}
