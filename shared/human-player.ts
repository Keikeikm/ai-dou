export interface HumanControlGrant {
  readonly playerId: string;
  readonly seat: number;
  readonly token: string;
}

export type HumanAction = { readonly type: 'call'; readonly score: 0 | 1 | 2 | 3 }
  | { readonly type: 'play'; readonly cards: readonly string[] }
  | { readonly type: 'pass' };

export interface HumanSubmission {
  readonly generation: number;
  readonly decisionId: string;
  readonly action: HumanAction;
}
