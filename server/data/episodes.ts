import { createHash } from 'node:crypto';
import { createGame } from '../game/game.js';
import { applyGameAction } from '../game/actions.js';
import { captureSnapshot } from '../game/snapshots.js';
import { createAgentRequest } from '../agents/protocol.js';
import { identifyCombination } from '../game/combos.js';
import { createBluffGame, applyBluffAction, observeBluff, type BluffState } from '../bluff/game.js';
import { emptyMetrics, type EpisodeRaw, type EpisodeSummary, type DataPlayer, type EpisodeStatus, type StoredEpisode } from '../../shared/game-data.js';
import { combinationNames } from '../../shared/analysis-support.js';
import { LEGACY_BLUFF_RULES_VERSION } from '../../shared/bluff.js';

export interface EpisodeInput { id: string; roomId: string; generation: number; startedAt: number; endedAt?: number; status: EpisodeStatus; players: DataPlayer[]; raw: EpisodeRaw; imported?: boolean }
export function cleanJournal(journal: Extract<EpisodeRaw, { game: 'doudizhu' }>['journal']) {
  // Whitelist useful decision metadata. Never retain raw model text, transport details or credentials here.
  return { version: journal.version, seed: journal.seed, players: [...journal.players], status: journal.status,
    ...(journal.baseScore !== undefined ? { baseScore: journal.baseScore } : {}),
    ...(journal.settlement ? { settlement: journal.settlement } : {}),
    turns: journal.turns.map((turn) => ({ sequence: turn.sequence, seat: turn.seat, phase: turn.phase, action: turn.action, source: turn.source,
      ...(turn.at !== undefined ? { at: turn.at } : {}), ...(turn.durationMs !== undefined ? { durationMs: turn.durationMs } : {}),
      ...(turn.decisionKind ? { decisionKind: turn.decisionKind } : {}), ...(turn.reason ? { reason: turn.reason } : {}),
      ...(turn.modelResponse ? { modelResponse: { provider: turn.modelResponse.provider, model: turn.modelResponse.model, status: turn.modelResponse.status,
        durationMs: turn.modelResponse.durationMs, ...(turn.modelResponse.usage ? { usage: turn.modelResponse.usage } : {}),
        ...(turn.modelResponse.strategy ? { strategy: turn.modelResponse.strategy } : {}) } } : {}) })) };
}
export function bluffInitial(raw: Extract<EpisodeRaw, { game: 'bluff' }>): BluffState {
  const state = createBluffGame(undefined, raw.rulesVersion ?? LEGACY_BLUFF_RULES_VERSION); state.hands = structuredClone(raw.initialHands); return state;
}
export function summarizeEpisode(input: EpisodeInput, now = Date.now()): StoredEpisode {
  const raw: EpisodeRaw = input.raw.game === 'doudizhu' ? { game: 'doudizhu', journal: cleanJournal(input.raw.journal) } : structuredClone(input.raw);
  const players = input.players.map((player) => ({ ...player, metrics: emptyMetrics(), won: null as boolean | null, role: '对手' }));
  let finished = false;
  if (raw.game === 'bluff') {
    const state = bluffInitial(raw);
    for (const step of raw.steps) {
      const m = players.find((player) => player.seat === step.seat)!.metrics;
      m.actions++;
      if (step.source === 'model') { m.modelMs += step.durationMs; m.modelSamples++; }
      const action = step.action;
      if (action.type === 'play') {
        m.plays++; m.cardsPlayed += action.cards.length;
        const rank = observeBluff(state, step.seat).rank;
        const lied = state.hands[step.seat].some((card) => action.cards.includes(card.id) && card.rank !== rank);
        if (lied) m.bluffs++;
        const label = lied ? '吹牛出牌' : '如实出牌'; m.distribution[label] = (m.distribution[label] ?? 0) + 1;
      } else { m.responses++; if (action.type === 'challenge') m.challenges++;
        const label = action.type === 'challenge' ? '质疑' : '相信'; m.distribution[label] = (m.distribution[label] ?? 0) + 1; }
      applyBluffAction(state, step.seat, action);
      if (action.type === 'challenge' && state.lastReveal?.loser !== step.seat) m.challengesWon++;
    }
    finished = state.phase === 'finished';
    if (finished) players.forEach((player) => { player.won = player.seat === state.winner; });
  } else {
    let state = createGame(raw.journal.seed);
    for (const turn of raw.journal.turns) {
      const m = players.find((player) => player.seat === turn.seat)!.metrics;
      m.actions++; if (turn.source === 'fallback') m.fallbacks++;
      if (turn.action.type === 'play') {
        m.plays++; m.cardsPlayed += turn.action.cards.length;
        const type = identifyCombination(turn.action.cards)?.type ?? 'unknown';
        if (type === 'bomb' || type === 'rocket') m.bombs++;
        const label = combinationNames[type] ?? '其他出牌'; m.distribution[label] = (m.distribution[label] ?? 0) + 1;
      } else if (turn.action.type === 'pass') { m.passes++; m.distribution['不出'] = (m.distribution['不出'] ?? 0) + 1; }
      else { m.bids++; m.bidTotal += turn.action.score; m.distribution['叫分'] = (m.distribution['叫分'] ?? 0) + 1; }
      if (turn.modelResponse) {
        m.modelMs += turn.modelResponse.durationMs; m.modelSamples++;
        if (turn.modelResponse.usage?.totalTokens !== undefined) { m.tokens += turn.modelResponse.usage.totalTokens; m.tokenSamples++; }
      }
      state = applyGameAction(state, turn.seat, turn.action);
    }
    finished = state.phase === 'finished';
    players.forEach((player) => {
      player.role = state.landlord < 0 ? '未定' : player.seat === state.landlord ? '地主' : '农民';
      if (finished) player.won = (state.winner === 'landlord') === (player.seat === state.landlord);
    });
  }
  const status = finished ? 'finished' : input.status === 'finished' ? 'interrupted' : input.status;
  return { id: input.id, roomId: input.roomId, generation: input.generation, startedAt: input.startedAt, updatedAt: now,
    game: raw.game, schemaVersion: 1, rulesVersion: raw.game === 'bluff' ? raw.rulesVersion ?? LEGACY_BLUFF_RULES_VERSION : 'doudizhu-v1',
    status, finishedAt: status === 'finished' ? input.endedAt ?? (raw.game === 'bluff' ? raw.steps.at(-1)?.at : raw.journal.turns.at(-1)?.at) ?? now : null, players, imported: input.imported ?? false,
    steps: raw.game === 'bluff' ? raw.steps.length : raw.journal.turns.length, raw };
}
export function summaryOnly(episode: StoredEpisode): EpisodeSummary { const { raw: _, ...summary } = episode; return summary; }

export function* trainingTransitions(episode: StoredEpisode, profileId?: string) {
  const splitNumber = parseInt(createHash('sha256').update(episode.id).digest('hex').slice(0, 8), 16) % 100;
  const split = splitNumber < 80 ? 'train' : splitNumber < 90 ? 'validation' : 'test';
  const raw = episode.raw;
  let dd = raw.game === 'doudizhu' ? createGame(raw.journal.seed) : null;
  const bluff = raw.game === 'bluff' ? bluffInitial(raw) : null;
  const steps = raw.game === 'bluff' ? raw.steps : raw.journal.turns;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const actor = episode.players.find((player) => player.seat === step.seat)!;
    const ddView = () => {
      if (!dd) return null;
      // A finished state has no legal next decision request; expose a safe terminal observation instead.
      if (dd.phase === 'finished') return { phase: 'finished', seat: step.seat, hand_cards: dd.hands[step.seat].map((card) => card.id),
        remaining: dd.hands.map((hand) => hand.length), winner: dd.winner };
      const request = createAgentRequest({ ...dd, currentSeat: step.seat }, { roomId: episode.roomId, generation: episode.generation, round: index + 1, deadline: 0 });
      const { request_id: _, deadline_at: __, ...observation } = request;
      return { ...observation, current_actor: dd.currentSeat };
    };
    const observation = bluff ? observeBluff(bluff, step.seat as 0 | 1) : ddView();
    const action = raw.game === 'bluff' ? raw.steps[index].action : raw.journal.turns[index].action;
    if (bluff && raw.game === 'bluff') applyBluffAction(bluff, raw.steps[index].seat, raw.steps[index].action);
    if (dd && raw.game === 'doudizhu') dd = applyGameAction(dd, step.seat, raw.journal.turns[index].action);
    const nextObservation = bluff ? observeBluff(bluff, step.seat as 0 | 1) : ddView();
    const last = index === steps.length - 1;
    const terminated = last && episode.status === 'finished';
    const truncated = last && episode.status !== 'finished';
    const source = raw.game === 'bluff' ? raw.steps[index].source : raw.journal.turns[index].source === 'fallback' ? 'fallback' : raw.journal.turns[index].decisionKind ?? (actor.kind === 'human' ? 'human' : 'unknown');
    if (profileId && actor.profileId !== profileId) continue;
    yield { schema_version: 1, game: episode.game, rules_version: episode.rulesVersion, episode_id: episode.id, split, step: index + 1,
      actor_id: actor.profileId, actor_name: actor.name, actor_seat: actor.seat, behavior_source: source, policy: { kind: actor.kind, model: actor.model ?? null, strategy: actor.strategy ?? null },
      observation, action, next_observation: nextObservation, next_observation_timing: 'after_one_environment_action',
      reward: truncated ? null : terminated ? actor.won ? 1 : -1 : 0,
      reward_by_seat: terminated ? episode.players.map((player) => ({ seat: player.seat, reward: player.won ? 1 : -1 })) : null,
      terminated, truncated, outcome: actor.won, imitation_eligible: source === 'human' || source === 'model',
      timestamp: raw.game === 'bluff' ? raw.steps[index].at : raw.journal.turns[index].at ?? null };
  }
}

export function episodeSnapshots(episode: StoredEpisode) {
  if (episode.raw.game === 'bluff') {
    const state = bluffInitial(episode.raw);
    const snapshots = [observeBluff(state, 0)];
    for (const step of episode.raw.steps) { applyBluffAction(state, step.seat, step.action); snapshots.push(observeBluff(state, 0)); }
    return snapshots;
  }
  let state = createGame(episode.raw.journal.seed);
  const snapshots = [captureSnapshot(state, episode.raw.journal.players, episode.raw.journal.baseScore)];
  for (const step of episode.raw.journal.turns) { state = applyGameAction(state, step.seat, step.action); snapshots.push(captureSnapshot(state, episode.raw.journal.players, episode.raw.journal.baseScore)); }
  return snapshots;
}
