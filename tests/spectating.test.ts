import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createReplayServer } from '../server/http/replay-server.js';

describe('spectator decision progress API', () => {
  it('pushes an authoritative HTTP Agent deadline through SSE and clears it on cancellation', async () => {
    let pendingResponse: ServerResponse | undefined;
    let markRequested!: () => void;
    const requested = new Promise<void>((resolveRequested) => { markRequested = resolveRequested; });
    const agent = createServer((request, response) => { request.resume(); pendingResponse = response; markRequested(); });
    agent.listen(0, '127.0.0.1');
    await once(agent, 'listening');
    const agentOrigin = 'http://127.0.0.1:' + (agent.address() as AddressInfo).port;
    const server = createReplayServer({ agentAllowedOrigins: [agentOrigin], turnTimeoutMs: 3000 });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const controller = new AbortController();
    const post = async (path: string, body: unknown) => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const room = await (await post('/api/rooms', { players: [0, 1, 2].map((seat) => ({ name: 'Slow ' + seat, kind: 'http', seat, api_url: agentOrigin + '/decide' })) })).json();
      const base = '/api/rooms/' + room.id;
      const events = await fetch(origin + base + '/events', { signal: controller.signal });
      const reader = events.body!.getReader();
      await reader.read();
      await post(base + '/control', { action: 'start' });
      await requested;
      const replay = await (await fetch(origin + base + '/replay')).json();
      expect(replay.session.decision).toMatchObject({ seat: 0, phase: 'calling', sequence: 1 });
      expect(replay.session.decision.deadline - replay.session.decision.startedAt).toBe(3000);
      expect(replay.session.decision.deadline).toBeGreaterThan(replay.session.serverTime);
      expect(replay.snapshots).toHaveLength(1);
      let received = '';
      for (let chunk = 0; chunk < 5 && !received.includes('"deadline"'); chunk += 1) received += new TextDecoder().decode((await reader.read()).value);
      expect(received).toContain('"deadline":' + replay.session.decision.deadline);
      expect(received).not.toMatch(/api_key|api_url|Authorization/);
      const paused = await (await post(base + '/control', { action: 'pause' })).json();
      expect(paused.session.decision).toBeNull();
      expect(paused.session.status).toBe('paused');
      expect(paused.turns).toHaveLength(0);
      expect((await (await fetch(origin + base + '/journal')).json())).not.toHaveProperty('decision');
    } finally {
      controller.abort();
      pendingResponse?.end();
      await new Promise<void>((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections(); });
      await new Promise<void>((resolveClose) => { agent.close(() => resolveClose()); agent.closeAllConnections(); });
    }
  });
});
