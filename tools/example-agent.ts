import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeck } from '../server/game/cards.js';
import { GreedyBot } from '../server/agents/bots.js';
import { identifyCombination } from '../server/game/combos.js';
import { parseAgentRequest, responseForAction, type AgentRequest } from '../server/agents/protocol.js';
import { normalizeApiKey } from '../server/agents/http.js';
import type { GameState } from '../server/game/game.js';

export function decideExampleRequest(request: AgentRequest) {
  const cards = new Map(createDeck().map((card) => [card.id, card]));
  const hands: GameState['hands'] = [[], [], []];
  hands[request.seat] = request.hand_cards.map((id) => cards.get(id)!);
  const combination = request.last_play ? identifyCombination(request.last_play.cards.map((id) => cards.get(id)!)) : undefined;
  if (request.last_play && !combination) throw new Error('Invalid last play');
  const state: GameState = {
    hands, currentSeat: request.seat, phase: request.action_type === 'call' ? 'calling' : 'playing',
    landlord: request.role === null ? -1 : request.role === 'landlord' ? request.seat : (request.seat + 1) % 3,
    callScore: request.call_score as 1 | 2 | 3, bottomCards: request.bottom_cards.map((id) => cards.get(id)!),
    logs: [], passCount: 0,
    lastPlay: request.last_play && combination ? { seat: request.last_play.seat, combination } : undefined,
  };
  return responseForAction(request, new GreedyBot().decide(state));
}

export function createExampleAgentServer(apiKey?: string) {
  const key = normalizeApiKey(apiKey);
  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    const send = (status: number, value: unknown) => { response.writeHead(status); response.end(JSON.stringify(value)); };
    if (request.url !== '/decide') { request.resume(); send(404, { error: 'Not found' }); return; }
    if (request.method !== 'POST') { request.resume(); send(405, { error: 'Use POST' }); return; }
    if (key) {
      const expected = Buffer.from('Bearer ' + key);
      const supplied = Buffer.from(request.headers.authorization ?? '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { request.resume(); send(401, { error: 'Unauthorized' }); return; }
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) { request.resume(); send(415, { error: 'Use application/json' }); return; }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 262144) { send(413, { error: 'Request too large' }); request.resume(); return; }
        chunks.push(chunk);
      }
      const input = parseAgentRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      send(200, decideExampleRequest(input));
    } catch { if (!response.headersSent) send(400, { error: 'Invalid decision request' }); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.AGENT_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid AGENT_PORT');
  const server = createExampleAgentServer(process.env.AGENT_API_KEY);
  server.on('error', () => { console.error('Unable to start the example Agent'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log('AI DOU example Agent: http://127.0.0.1:' + port + '/decide'));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { server.close(); server.closeAllConnections(); });
}
