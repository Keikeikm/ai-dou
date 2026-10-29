import { createGame, type GameState } from '../game/game.js';
import { applyGameAction } from '../game/actions.js';
import { captureSnapshot, type GameSnapshot } from '../game/snapshots.js';
import type { Bot, BotAction } from './bots.js';
export type { GameSnapshot } from '../game/snapshots.js';

export interface BotGameAction {
  readonly seat: number;
  readonly bot: string;
  readonly action: BotAction;
}

export interface BotGameResult {
  readonly state: GameState;
  readonly actions: readonly BotGameAction[];
}

function executeBotGame(
  bots: readonly [Bot, Bot, Bot],
  seed: number | undefined,
  observe?: (state: GameState) => void,
): BotGameResult {
  let state = createGame(seed);
  const actions: BotGameAction[] = [];
  observe?.(state);

  while (state.phase !== 'finished') {
    const seat = state.currentSeat;
    const bot = bots[seat];
    const action = bot.decide(state);

    state = applyGameAction(state, seat, action);
    actions.push({ seat, bot: bot.name, action });
    observe?.(state);
  }

  return { state, actions };
}

export function runReplayGame(bots: readonly [Bot, Bot, Bot], seed: number): GameSnapshot[] {
  const snapshots: GameSnapshot[] = [];
  executeBotGame(bots, seed, (state) => {
    snapshots.push(captureSnapshot(state, bots.map((bot) => bot.name)));
  });
  return snapshots;
}

export function runBotGame(bots: readonly [Bot, Bot, Bot], seed?: number): BotGameResult {
  return executeBotGame(bots, seed);
}
