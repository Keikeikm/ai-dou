import { createBluffGame, applyBluffAction } from '../server/bluff/game.js';
import { createGame } from '../server/game/game.js';
import { applyGameAction } from '../server/game/actions.js';
import type { BotAction } from '../server/agents/bots.js';
import type { EpisodeInput } from '../server/data/episodes.js';
import type { BluffAction } from '../shared/bluff.js';
import type { BluffStep } from '../shared/game-data.js';
import type { TurnRecord } from '../server/rooms/scheduler.js';

export function bluffEpisode(id = 'bluff_test_1', complete = true): EpisodeInput {
  const state = createBluffGame(() => .999);
  const initialHands = structuredClone(state.hands); const steps: BluffStep[] = [];
  while (state.phase !== 'finished') {
    const seat = state.turn;
    const action: BluffAction = state.phase === 'respond' ? { type: 'accept' } : { type: 'play', cards: state.hands[seat].slice(0, 4).map((c) => c.id) };
    steps.push({ seat, action, at: 1000 + steps.length * 10, durationMs: 10, source: seat === 0 ? 'human' : 'model' });
    applyBluffAction(state, seat, action);
    if (!complete && steps.length === 3) break;
  }
  return { id, roomId: 'bluff_test', generation: 1, startedAt: Date.parse('2026-11-01T12:00:00+08:00'), status: complete ? 'finished' : 'active',
    players: [{ profileId: 'human_local', name: '我', seat: 0, kind: 'human', identity: 'profile' }, { profileId: 'agent_whale', name: '鲸鱼娘', seat: 1, kind: 'deepseek', model: 'deepseek-flash', identity: 'agent' }], raw: { game: 'bluff', rulesVersion: state.rulesVersion, initialHands, steps } };
}
export function ddEpisode(id = 'game_test_1'): EpisodeInput {
  let state = createGame(3); const turns: TurnRecord[] = [];
  while (state.phase !== 'finished') {
    const seat = state.currentSeat;
    const action: BotAction = state.phase === 'calling' ? { type: 'call', score: 3 } : state.lastPlay ? { type: 'pass' } : { type: 'play', cards: [state.hands[seat][0]] };
    turns.push({ sequence: turns.length + 1, seat, phase: state.phase, source: seat === 0 ? 'human' : 'agent', decisionKind: seat === 0 ? 'human' : 'bot', action });
    state = applyGameAction(state, seat, action);
  }
  return { id, roomId: 'room_123456789012', generation: 1, startedAt: 10000, status: 'finished', players: [0, 1, 2].map((seat) => ({ profileId: seat === 0 ? 'human_local' : 'agent_' + seat, name: '玩家' + seat, kind: seat === 0 ? 'human' : 'greedy', seat, identity: seat === 0 ? 'profile' : 'agent' })), raw: { game: 'doudizhu', journal: { version: 1, seed: 3, players: ['玩家0', '玩家1', '玩家2'], status: 'finished', turns } } };
}
