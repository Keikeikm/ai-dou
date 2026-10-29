import { vi } from 'vitest';
import { RoomManager } from '../../server/rooms/room-manager.js';
import type { DeepSeekCompletionRequest } from '../../server/agents/deepseek.js';
import { saveHumanControl } from '../../client/domain/human-control.js';

export function fixture(options: { waiting?: boolean; model?: boolean; human?: boolean; spectator?: boolean; noKey?: boolean; oldBackend?: boolean; reducedMotion?: boolean; failure?: string; status?: number } = {}) {
  const requests: { path: string; method: string; body: Record<string, unknown> }[] = [];
  let calls = 0;
  const modelRequests: DeepSeekCompletionRequest[] = [];
  const manager = new RoomManager({ stepIntervalMs: 0, agentAllowedOrigins: ['http://127.0.0.1:8787'], deepseek: {
    apiKey: options.noKey ? undefined : 'test-only-shared-key', transport: async (_credentials, request) => {
      calls += 1;
      modelRequests.push(request);
      if (options.status) { const { AgentHttpError } = await import('../../server/agents/http.js'); throw new AgentHttpError(options.status); }
      return { choices: [{ finish_reason: 'stop', message: { content: options.failure ?? '{"action_index":0}' } }] };
    },
  } });
  const room = manager.create({ seed: 7, players: options.waiting ? [] : [0, 1, 2].map((seat) => ({ name: 'Agent ' + seat, kind: options.human && seat === 1 ? 'human' : options.model ? 'deepseek' : seat === 0 ? 'random' : 'greedy', seat })) });
  const sources: MockEventSource[] = [];
  class MockEventSource {
    onmessage: ((event: { data: string }) => void) | null = null;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    unsubscribe: () => void;
    constructor(readonly url: string) {
      sources.push(this);
      const id = url.match(/\/rooms\/(room_[a-f0-9]{12})/)?.[1] ?? room.id;
      this.unsubscribe = manager.watch(id, () => { if (!this.closed) this.onmessage?.({ data: JSON.stringify(manager.getReplay(id)) }); });
    }
    close() { if (this.closed) return; this.closed = true; this.unsubscribe(); }
    emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  vi.stubGlobal('EventSource', MockEventSource);
  vi.stubGlobal('matchMedia', () => ({ matches: options.reducedMotion !== false }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const method = init.method ?? 'GET';
    requests.push({ path: url, method, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    try {
      if (url === '/api/config') return options.oldBackend ? json({ error: 'Old server' }, 404) : json({ baseScore: 1, capabilities: { randomDeals: true, modelResponses: true, humanPlayers: true } });
      if (url === '/api/providers/deepseek') return json(manager.getDeepSeekConfiguration());
      if (url === '/api/analysis/config') return json({ enabled: false, model: 'deepseek-flash' });
      if (url === '/api/rooms' && method === 'POST') return json(manager.create(body), 201);
      const id = url.match(/^\/api\/rooms\/(room_[a-f0-9]{12})/)?.[1] ?? room.id;
      if (url.endsWith('/control')) return json(await manager.control(id, body.action));
      if (url.endsWith('/human-action')) return json(manager.submitHumanAction(id, (init.headers as Record<string, string>)?.Authorization?.replace('Bearer ', ''), body));
      if (url.endsWith('/players')) return json(manager.join(id, body));
      const key = url.match(/\/players\/([^/]+)\/api-key$/);
      if (key) return json(manager.updateApiKey(id, key[1], body.api_key));
      const check = url.match(/\/players\/([^/]+)\/check$/);
      if (check) return json(await manager.checkAgent(id, check[1]));
      if (url.includes('/games?')) return json(manager.getRoomGames(id));
      const archive = url.match(/^\/api\/games\/(game_[a-f0-9]{12}_[1-9][0-9]*)\/replay$/);
      if (archive) {
        const record = manager.getGameRecord(archive[1]);
        return json({ ...record, snapshots: manager.getReplay(record.roomId).snapshots });
      }
      return json(manager.getReplay(id));
    } catch (failure) { return json({ error: failure instanceof Error ? failure.message : 'Failed' }, (failure as { statusCode?: number }).statusCode ?? 500); }
  }));
  sessionStorage.clear();
  if (room.humanControl && !options.spectator) saveHumanControl(room.id, room.humanControl);
  return {
    room, manager, requests, sources, modelRequests, calls: () => calls,
    replay: () => manager.getReplay(room.id),
    finish: async () => { for (let step = 0; step < 300 && manager.get(room.id).status !== 'finished'; step += 1) await manager.control(room.id, 'step'); },
    dispose: () => { for (const source of sources) source.close(); manager.dispose(); },
  };
}
