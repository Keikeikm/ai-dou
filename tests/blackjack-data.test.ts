import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeck } from '../server/game/cards.js';
import { DataStore } from '../server/data/store.js';
import { dataFilter } from '../server/data/http.js';
import { episodeSnapshots, summarizeEpisode, trainingTransitions, type EpisodeInput } from '../server/data/episodes.js';
import { BLACKJACK_RULES_VERSION, type BlackjackObservation } from '../shared/blackjack.js';
import type { BlackjackStep } from '../shared/game-data.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture(ranks = ['10', '9', '8', '9'], actions: [0 | 1, 'hit' | 'stand'][] = [[0, 'stand'], [1, 'stand']]): EpisodeInput {
  const remaining = createDeck().filter((card) => card.suit !== 'joker');
  const front = ranks.map((rank) => remaining.splice(remaining.findIndex((card) => card.rank === rank), 1)[0]);
  const steps: BlackjackStep[] = actions.map(([seat, type], index) => ({ seat, action: { type }, source: seat === 0 ? 'human' : 'model', durationMs: seat ? 10 : 0, at: 1000 + index }));
  return { id: 'blackjack_data_1', roomId: 'blackjack_data', generation: 1, startedAt: 900, status: 'finished',
    players: [{ profileId: 'human_local', name: '我', seat: 0, kind: 'human', identity: 'profile' }, { profileId: 'agent_whale', name: '鲸鱼娘', seat: 1, kind: 'deepseek', model: 'test', identity: 'agent' }],
    raw: { game: 'blackjack', rulesVersion: BLACKJACK_RULES_VERSION, deck: [...front, ...remaining], steps } };
}
function store() { const data = new DataStore(); cleanups.push(() => data.close()); return data; }

describe('21 点档案与训练数据', () => {
  it('persists ties with explicit push labels and zero terminal rewards', () => {
    const data = store(); data.save(fixture());
    const episode = data.get('blackjack_data_1')!;
    expect(episode).toMatchObject({ game: 'blackjack', status: 'finished', rulesVersion: BLACKJACK_RULES_VERSION, steps: 2 });
    expect(episode.players.map((p) => [p.won, p.outcome])).toEqual([[null, 'push'], [null, 'push']]);
    const aggregate = data.query({ game: 'blackjack' });
    expect(aggregate.overview.gameCounts.blackjack).toBe(1);
    expect(aggregate.overview.players[0]).toMatchObject({ wins: 0, draws: 1, completed: 1 });
    const transitions = [...trainingTransitions(episode)];
    expect(transitions.at(-1)).toMatchObject({ terminated: true, truncated: false, reward: 0, outcome: null, outcome_label: 'push',
      reward_by_seat: [{ seat: 0, reward: 0 }, { seat: 1, reward: 0 }] });
    expect(episode.players[1].metrics).toMatchObject({ modelSamples: 1, modelMs: 10, distribution: { '停牌': 1 } });
  });

  it('exports each actor’s private view without hidden cards or the remaining deck', () => {
    const input = fixture(['5', '4', '6', '7', '3', '2'], [[0, 'hit'], [1, 'hit'], [0, 'stand'], [1, 'stand']]);
    const episode = summarizeEpisode(input);
    if (input.raw.game !== 'blackjack') throw new Error();
    const transitions = [...trainingTransitions(episode)];
    const human = transitions[2].observation as BlackjackObservation;
    expect(human.handValue.total).toBe(14);
    expect(human.opponent).toEqual([input.raw.deck[1], null, null]);
    expect(human.opponentValue).toBeNull();
    expect(human).not.toHaveProperty('deck'); expect(human).not.toHaveProperty('initialDeck');
    expect(JSON.stringify(human)).not.toContain(input.raw.deck[3].id);
    expect(JSON.stringify(human)).not.toContain(input.raw.deck[5].id);
    const ai = transitions[1].observation as BlackjackObservation;
    expect(ai.handValue.total).toBe(11);
    expect(ai.opponent).toEqual([input.raw.deck[0], null, null]);
    expect(JSON.stringify(ai)).not.toContain(input.raw.deck[2].id);
    expect(JSON.stringify(ai)).not.toContain(input.raw.deck[4].id);
    expect(transitions[1]).toMatchObject({ behavior_source: 'model', imitation_eligible: true });
    expect([...trainingTransitions(episode, 'human_local')].map((t) => t.step)).toEqual([1, 3]);
    expect(transitions.at(-1)).toMatchObject({ reward: -1, outcome_label: 'loss', reward_by_seat: [{ seat: 0, reward: 1 }, { seat: 1, reward: -1 }] });
    const snapshots = episodeSnapshots(episode) as BlackjackObservation[];
    expect(snapshots).toHaveLength(5); expect(snapshots.at(-1)?.opponentValue?.total).toBe(13);
  });

  it.each([
    { ranks: ['A', '9', 'K', '8'], outcomes: ['win', 'loss'] },
    { ranks: ['A', 'A', 'K', 'Q'], outcomes: ['push', 'push'] },
  ])('retains natural endings without inventing a decision: $outcomes', ({ ranks, outcomes }) => {
    const data = store(); data.save(fixture(ranks, []));
    const episode = data.get('blackjack_data_1')!;
    expect(episode).toMatchObject({ status: 'finished', steps: 0 });
    expect(episode.players.map((p) => p.outcome)).toEqual(outcomes);
    expect([...trainingTransitions(episode)]).toEqual([]);
    expect(episodeSnapshots(episode)).toHaveLength(1);
    expect(data.query({ game: 'blackjack', status: 'finished' }).overview).toMatchObject({ total: 1, finished: 1, steps: 0 });
  });

  it('keeps incomplete zero-action deals private and recovers them after restarting storage', () => {
    const folder = mkdtempSync(join(tmpdir(), 'blackjack-data-')); cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
    const path = join(folder, 'data.sqlite');
    const first = new DataStore(path); cleanups.push(() => first.close());
    first.save({ ...fixture(undefined, []), status: 'active' });
    expect(first.get('blackjack_data_1')).toBeNull();
    expect(first.query({ game: 'blackjack' })).toMatchObject({ total: 0, active: 1 });
    first.close(); const second = new DataStore(path); cleanups.push(() => second.close());
    expect(second.get('blackjack_data_1')).toMatchObject({ status: 'interrupted', steps: 0 });
    expect(second.get('blackjack_data_1')?.players.every((p) => p.won === null && !p.outcome)).toBe(true);
  });

  it('distinguishes a truncated duel from a tie, and accepts only known rule versions', () => {
    const input = { ...fixture(['5', '4', '6', '7', '3'], [[0, 'hit']]), status: 'abandoned' as const };
    const transition = [...trainingTransitions(summarizeEpisode(input))][0];
    expect(transition).toMatchObject({ terminated: false, truncated: true, reward: null, outcome: null, outcome_label: null });
    expect(dataFilter(new URL('http://localhost/api/data/overview?game=blackjack'))).toEqual({ game: 'blackjack' });
    if (input.raw.game !== 'blackjack') throw new Error();
    expect(() => summarizeEpisode({ ...input, raw: { ...input.raw, rulesVersion: 'future-rules' } })).toThrow('规则版本');
  });
});
