import { describe, expect, it } from 'vitest';
import { createDefaultBots } from '../server/agents/bots.js';
import { runBotGame, runReplayGame } from '../server/agents/bot-game.js';
import { replayJournal } from '../server/rooms/scheduler.js';
import { createReplayServer } from '../server/http/replay-server.js';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

describe('game replay snapshots', () => {
  it('captures every state transition for the UI', () => {
    const snapshots = runReplayGame(createDefaultBots(7), 7);

    expect(snapshots.length).toBeGreaterThan(3);
    expect(snapshots[0]).toMatchObject({ phase: 'calling', landlord: -1 });
    expect(snapshots.at(-1)).toMatchObject({ phase: 'finished' });
    expect(['landlord', 'farmers']).toContain(snapshots.at(-1)?.winner);

    for (const snapshot of snapshots) {
      expect(snapshot.hands).toHaveLength(3);
      expect(snapshot.bottomCards).toHaveLength(3);
      expect(snapshot.currentSeat).toBeGreaterThanOrEqual(0);
      expect(snapshot.currentSeat).toBeLessThanOrEqual(2);
    }
  });

  it('uses the same authoritative game flow as the CLI and keeps snapshots independent', () => {
    const snapshots = runReplayGame(createDefaultBots(7), 7);
    const game = runBotGame(createDefaultBots(7), 7);
    const final = snapshots.at(-1)!;
    expect(final.hands).toEqual(game.state.hands);
    expect(final.logs).toEqual(game.state.logs);
    expect(final.winner).toBe(game.state.winner);
    expect(snapshots).toHaveLength(game.actions.length + 1);
    expect(snapshots[0].hands.map((hand) => hand.length)).toEqual([17, 17, 17]);
    expect(snapshots[0].logs).toHaveLength(1);
    for (let step = 1; step < snapshots.length; step += 1) {
      const before = snapshots[step - 1];
      const after = snapshots[step];
      const action = game.actions[step - 1];
      if (action.action.type === 'play') {
        expect(after.hands[action.seat]).toHaveLength(
          before.hands[action.seat].length - action.action.cards.length,
        );
      }
      expect(after.logs.length).toBeGreaterThan(before.logs.length);
      expect(after.hands.flat().every((card) => card.suit && card.rank && card.id)).toBe(true);
    }
  });

  it('serves the room, local artwork, and a complete replay on loopback', async () => {
    const server = createReplayServer({ stepIntervalMs: 0 });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    try {
      const page = await fetch(origin + '/');
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(await page.text()).toContain('id="root"');
      expect((await fetch(origin + '/api/replay')).status).toBe(404);
      const created = await (await fetch(origin + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seed: 7, players: [
        { name: 'Random Bot', kind: 'random', seat: 0 }, { name: 'Greedy Bot', kind: 'greedy', seat: 1 }, { name: 'Greedy Bot', kind: 'greedy', seat: 2 },
      ] }) })).json();
      const base = '/api/rooms/' + created.id;
      const replay = await (await fetch(origin + base + '/replay')).json();
      expect(replay.seed).toBe(7);
      expect(replay.snapshots).toHaveLength(1);
      expect(replay.session.status).toBe('idle');
      for (const name of ['violet', 'amber', 'azure']) {
        const artwork = await fetch(origin + '/avatars/' + name + '.png');
        expect(artwork.status).toBe(200);
        expect(artwork.headers.get('content-type')).toBe('image/png');
        expect(new Uint8Array(await artwork.arrayBuffer()).slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
      }
      expect((await fetch(origin + '/room.js', { method: 'HEAD' })).status).toBe(404);
      expect((await fetch(origin + '/missing')).status).toBe(404);
      expect((await fetch(origin + base + '/replay', { method: 'POST' })).status).toBe(405);
      const control = async (action: string) => {
        const response = await fetch(origin + base + '/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
        expect(response.status).toBe(200);
        return response.json();
      };
      const stepped = await control('step');
      expect(stepped.snapshots).toHaveLength(2);
      const controller = new AbortController();
      const events = await fetch(origin + base + '/events', { signal: controller.signal });
      expect(events.headers.get('content-type')).toContain('text/event-stream');
      const reader = events.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain('"snapshots"');
      await control('step');
      const update = new TextDecoder().decode((await reader.read()).value);
      expect(update).toContain('"snapshot"');
      expect(update).toContain('"index":2');
      controller.abort();
      await control('start');
      let completed;
      for (let attempt = 0; attempt < 150; attempt += 1) {
        completed = await (await fetch(origin + base + '/replay')).json();
        if (completed.session.status === 'finished') break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
      expect(completed.session.status).toBe('finished');
      const journal = await (await fetch(origin + base + '/journal')).json();
      expect(replayJournal(journal)).toEqual(completed.snapshots);
      expect(JSON.stringify(replayJournal(journal))).toBe(JSON.stringify(completed.snapshots));
      const reset = await control('reset');
      expect(reset.generation).toBeGreaterThan(replay.generation);
      expect(reset.snapshots).toHaveLength(1);
      expect(reset.session.status).toBe('idle');
      expect((await fetch(origin + base + '/control', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.test' }, body: '{"action":"start"}' })).status).toBe(403);
      expect((await fetch(origin + base + '/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"unknown"}' })).status).toBe(400);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
        server.closeAllConnections();
      });
    }
  });
});
