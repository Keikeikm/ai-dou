import { createDeck, RANK_ORDER, type Card, type Rank } from '../game/cards.js';
import { identifyCombination } from '../game/combos.js';
import type { AgentRequest } from './protocol.js';

const deck = new Map(createDeck().map((card) => [card.id, card]));

function cardsFor(ids: readonly string[]): Card[] {
  return ids.map((id) => {
    const card = deck.get(id);
    if (!card) throw new Error('Unknown summary card');
    return card;
  });
}

function rankCounts(cards: readonly Card[]): Partial<Record<Rank, number>> {
  const counts: Partial<Record<Rank, number>> = {};
  for (const rank of RANK_ORDER) {
    const count = cards.filter((card) => card.rank === rank).length;
    if (count) counts[rank] = count;
  }
  return counts;
}

function runs(counts: Partial<Record<Rank, number>>, copies: number, minimum: number): Rank[][] {
  const sequences: Rank[][] = [];
  let sequence: Rank[] = [];
  for (const rank of RANK_ORDER.slice(0, 12)) {
    if ((counts[rank] ?? 0) >= copies) sequence.push(rank);
    else {
      if (sequence.length >= minimum) sequences.push(sequence);
      sequence = [];
    }
  }
  if (sequence.length >= minimum) sequences.push(sequence);
  return sequences;
}

export function createTacticalSummary(request: AgentRequest, publicLandlordSeat: number | null) {
  const ownCards = cardsFor(request.hand_cards);
  const counts = rankCounts(ownCards);
  const landlord = request.role === null ? null : publicLandlordSeat;
  const otherSeats = [0, 1, 2].filter((seat) => seat !== request.seat);
  const teammate = request.role === 'farmer' ? otherSeats.find((seat) => seat !== landlord) ?? null : null;
  const opponents = landlord === null ? [] : request.role === 'landlord' ? otherSeats : [landlord];
  const played = request.history.filter((entry) => entry.action === 'play');
  const lastCards = request.last_play ? cardsFor(request.last_play.cards) : [];
  let passes = 0;
  for (const entry of [...request.history].reverse()) {
    if (entry.action !== 'pass') break;
    passes += 1;
  }
  return {
    hand_structure: {
      rank_counts: counts,
      single_ranks: RANK_ORDER.filter((rank) => counts[rank] === 1),
      pair_ranks: RANK_ORDER.filter((rank) => counts[rank] === 2),
      triple_ranks: RANK_ORDER.filter((rank) => counts[rank] === 3),
      bomb_ranks: RANK_ORDER.filter((rank) => counts[rank] === 4),
      rocket: Boolean(counts['little-joker'] && counts['big-joker']),
      straight_runs: runs(counts, 1, 5), pair_runs: runs(counts, 2, 3), airplane_runs: runs(counts, 3, 2),
      control_card_count: ownCards.filter((card) => ['A', '2', 'little-joker', 'big-joker'].includes(card.rank)).length,
    },
    team: {
      landlord_seat: landlord, teammate_seat: teammate, opponent_seats: opponents,
      urgent_opponents: opponents.filter((seat) => request.visible_cards[('seat_' + seat) as keyof AgentRequest['visible_cards']] <= 2),
      teammate_near_finish: teammate !== null && request.visible_cards[('seat_' + teammate) as keyof AgentRequest['visible_cards']] <= 2,
    },
    public_play: {
      played_by_rank: rankCounts(cardsFor(played.flatMap((entry) => [...entry.cards]))),
      played_counts: [0, 1, 2].map((seat) => played.filter((entry) => entry.seat === seat).reduce((total, entry) => total + entry.cards.length, 0)),
      bomb_count: played.filter((entry) => ['bomb', 'rocket'].includes(identifyCombination(cardsFor(entry.cards))?.type ?? '')).length,
      last_play_type: identifyCombination(lastCards)?.type ?? null,
      last_play_relation: !request.last_play ? 'none' : request.last_play.seat === request.seat ? 'self' : request.last_play.seat === teammate ? 'teammate' : 'opponent',
      passes_since_last_play: passes,
    },
  };
}
