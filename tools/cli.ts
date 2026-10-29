import { formatCards } from '../server/game/cards.js';
import { runBotGame } from '../server/agents/bot-game.js';
import { createDefaultBots } from '../server/agents/bots.js';

const seed = process.argv[2] === undefined ? 1 : Number(process.argv[2]);
if (!Number.isInteger(seed) || seed < 0) {
  console.error('Usage: npm run cli [positive integer seed]');
  process.exit(1);
}

const { state, actions } = runBotGame(createDefaultBots(seed), seed);

for (const entry of state.logs) {
  const cards = entry.cards.length === 0 ? '' : ` [${formatCards(entry.cards)}]`;
  const message = entry.message ? ` ${entry.message}` : '';
  const score = entry.score === undefined ? '' : ` score=${entry.score}`;
  console.log(`seat ${entry.seat} ${entry.action}${cards}${score}${message}`);
}

console.log('\nBot actions:');
for (const action of actions) {
  const detail =
    action.action.type === 'call'
      ? `score=${action.action.score}`
      : action.action.type === 'play'
        ? `cards=[${formatCards(action.action.cards)}]`
        : '';
  console.log(`seat ${action.seat} ${action.bot} ${action.action.type} ${detail}`.trimEnd());
}

console.log(`\nWinner: ${state.winner === 'landlord' ? '\u5730\u4e3b' : '\u519c\u6c11'}`);
console.log('Final hands:');
state.hands.forEach((hand, index) => console.log(`  seat ${index}: ${formatCards(hand)}`));
