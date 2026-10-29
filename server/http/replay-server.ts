import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { RoomError, RoomManager, type RoomManagerOptions } from '../rooms/room-manager.js';
import { replayJournal } from '../rooms/scheduler.js';
import { ReplayChatService, type ReplayChatOptions } from '../analysis/replay-chat.js';

const webRoot = resolve(process.cwd(), 'client/public');
const assets = new Map([
  ['/agent-api', ['../../docs/AGENT_API.md', 'text/plain']],
  ['/scoring', ['../../docs/SCORING.md', 'text/plain']],
  ['/spectating', ['../../docs/SPECTATING.md', 'text/plain']],
  ['/deepseek', ['../../docs/DEEPSEEK.md', 'text/plain']],
  ['/human-play', ['../../docs/HUMAN_PLAY.md', 'text/plain']],
  ['/schemas/agent-request.schema.json', ['../../protocol/agent-request.schema.json', 'application/json']],
  ['/schemas/agent-response.schema.json', ['../../protocol/agent-response.schema.json', 'application/json']],
  ['/avatars/violet.png', ['avatars/violet.png', 'image/png']],
  ['/avatars/amber.png', ['avatars/amber.png', 'image/png']],
  ['/avatars/azure.png', ['avatars/azure.png', 'image/png']],
]);

function sendJson(response: ServerResponse, status: number, value: unknown, head = false): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(head ? undefined : JSON.stringify(value));
}

async function readBody(request: IncomingMessage, maxBytes = 4096): Promise<Record<string, unknown>> {
  const host = request.headers.host ?? '';
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) ||
    (request.headers.origin && request.headers.origin !== 'http://' + host) ||
    !request.headers['content-type']?.startsWith('application/json')) {
    request.resume();
    throw new RoomError(403, 'Only same-origin JSON controls are allowed');
  }
  if (Number(request.headers['content-length'] ?? 0) > maxBytes) {
    request.resume();
    throw new RoomError(413, 'Request body too large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) oversized = true;
    if (!oversized) chunks.push(chunk);
  }
  if (oversized) throw new RoomError(413, 'Request body too large');
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new RoomError(400, 'Invalid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new RoomError(400, 'Expected a JSON object');
  return parsed as Record<string, unknown>;
}

function watchRoom(manager: RoomManager, id: string, response: ServerResponse): void {
  const initial = manager.getReplay(id);
  if (initial.room.status === 'closed') throw new RoomError(409, 'Room is closed');
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
  response.write('data: ' + JSON.stringify(initial) + '\n\n');
  const unsubscribe = manager.watch(id, () => {
    const replay = manager.getReplay(id);
    if (response.destroyed || response.writableLength > 1024 * 1024) { response.end(); return; }
    response.write('data: ' + JSON.stringify({
      seed: replay.seed, generation: replay.generation, revision: replay.revision, room: replay.room, accounting: replay.accounting,
      session: replay.session, index: replay.snapshots.length - 1, snapshot: replay.snapshots.at(-1), turn: replay.turns.at(-1),
    }) + '\n\n');
    if (replay.room.status === 'closed') response.end();
  });
  const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
  heartbeat.unref();
  response.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
}

export interface ReplayServerOptions extends RoomManagerOptions {
  readonly frontendMiddleware?: ((request: IncomingMessage, response: ServerResponse, next: () => void) => void) | undefined;
  readonly replayAnalysis?: ReplayChatOptions;
}

export function createReplayServer(options: ReplayServerOptions = {}): Server {
  const manager = new RoomManager(options);
  const analysis = new ReplayChatService({ apiKey: options.deepseek?.apiKey, model: options.deepseek?.model, ...options.replayAnalysis });

  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const pathname = url.pathname;
      const head = request.method === 'HEAD';
      const read = request.method === 'GET' || head;
      if (pathname === '/api/config') {
        if (!read) { response.setHeader('Allow', 'GET, HEAD'); throw new RoomError(405, 'Method not allowed'); }
        sendJson(response, 200, { baseScore: options.baseScore ?? 1, capabilities: { randomDeals: true, modelResponses: true, humanPlayers: true } }, head);
        return;
      }
      if (pathname === '/api/providers/deepseek') {
        if (!read) { response.setHeader('Allow', 'GET, HEAD'); throw new RoomError(405, 'Method not allowed'); }
        sendJson(response, 200, manager.getDeepSeekConfiguration(), head);
        return;
      }
      if (pathname === '/api/analysis/config') {
        if (!read) { response.setHeader('Allow', 'GET, HEAD'); throw new RoomError(405, 'Method not allowed'); }
        sendJson(response, 200, analysis.configuration(), head);
        return;
      }
      const analysisRoute = pathname.match(/^\/api\/(rooms|games)\/(room_[a-f0-9]{12}|game_[a-f0-9]{12}_[1-9][0-9]*)\/analysis$/);
      if (analysisRoute) {
        if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); throw new RoomError(405, 'Method not allowed'); }
        const body = await readBody(request, 65536);
        const controller = new AbortController();
        const cancel = () => controller.abort();
        response.once('close', cancel);
        try {
          const source = analysisRoute[1] + ':' + analysisRoute[2];
          const replay = analysisRoute[1] === 'rooms' ? manager.getReplay(analysisRoute[2]) : (() => {
            const record = manager.getGameRecord(analysisRoute[2]);
            return { generation: record.generation, snapshots: replayJournal(record.journal), turns: record.journal.turns,
              room: { id: record.roomId, players: record.entries.map((entry) => ({ name: entry.name, seat: entry.seat, kind: 'archived' })) } };
          })();
          const result = await analysis.ask(source, replay, body, controller.signal);
          if (!response.destroyed) sendJson(response, 200, result);
        } finally { response.removeListener('close', cancel); }
        return;
      }
      const check = pathname.match(/^\/api\/rooms\/(room_[a-f0-9]{12})\/players\/([a-zA-Z0-9_-]+)\/check$/);
      if (check) {
        if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); throw new RoomError(405, 'Method not allowed'); }
        const body = await readBody(request);
        if (Object.keys(body).length !== 1 || body.confirm !== true) throw new RoomError(400, 'Confirm the single paid connection check with confirm: true');
        const controller = new AbortController();
        response.once('close', () => controller.abort());
        const result = await manager.checkAgent(check[1], check[2], controller.signal);
        if (!response.destroyed) sendJson(response, 200, result);
        return;
      }
      const game = pathname.match(/^\/api\/games\/(game_[a-f0-9]{12}_[1-9][0-9]*)(?:\/(journal|replay))?$/);
      const human = pathname.match(/^\/api\/rooms\/(room_[a-f0-9]{12})\/human-action$/);
      if (human) {
        if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); throw new RoomError(405, 'Method not allowed'); }
        const body = await readBody(request);
        const token = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
        sendJson(response, 200, manager.submitHumanAction(human[1], token, body));
        return;
      }
      const playerScore = pathname.match(/^\/api\/players\/([a-zA-Z0-9_-]{1,64})\/score$/);
      const roomGames = pathname.match(/^\/api\/rooms\/(room_[a-f0-9]{12})\/games$/);
      if (game || playerScore || roomGames) {
        if (!read) { response.setHeader('Allow', 'GET, HEAD'); throw new RoomError(405, 'Method not allowed'); }
        if (game) {
          const record = manager.getGameRecord(game[1]);
          if (game[2] === 'journal') response.setHeader('Content-Disposition', 'attachment; filename="' + game[1] + '-journal.json"');
          sendJson(response, 200, game[2] === 'journal' ? record.journal : game[2] === 'replay' ? { ...record, snapshots: replayJournal(record.journal) } : record, head);
        } else {
          const limit = Number(url.searchParams.get('limit') ?? 20);
          const offset = Number(url.searchParams.get('offset') ?? 0);
          if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 1000000) throw new RoomError(400, 'Invalid record pagination');
          sendJson(response, 200, playerScore ? manager.getPlayerLedger(playerScore[1], limit, offset) : manager.getRoomGames(roomGames![1], limit, offset), head);
        }
        return;
      }
      if (pathname === '/api/rooms' && request.method === 'POST') {
        const body = await readBody(request);
        const room = manager.create(body as Parameters<RoomManager['create']>[0]);
        sendJson(response, 201, room);
        return;
      }
      const explicit = pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]+)(?:\/(replay|events|journal|control|players)(?:\/([a-zA-Z0-9_-]+)(?:\/(api-key))?)?)?$/);
      if (/^\/api\/(replay|events|journal|control)$/.test(pathname)) throw new RoomError(404, 'No default game; create a room and use its scoped API');
      if (explicit) {
        const id = explicit[1];
        const resource = explicit[2];
        const playerId = explicit[3];
        const playerConfig = explicit[4];
        if (playerId && resource !== 'players') throw new RoomError(404, 'Not found');
        if (playerConfig) {
          if (request.method !== 'PUT') { response.setHeader('Allow', 'PUT'); throw new RoomError(405, 'Method not allowed'); }
          const body = await readBody(request);
          if (Object.keys(body).length !== 1 || !('api_key' in body)) throw new RoomError(400, 'Expected api_key (string or null)');
          sendJson(response, 200, manager.updateApiKey(id, playerId!, body.api_key));
          return;
        }
        if (read && !resource) { sendJson(response, 200, manager.get(id), head); return; }
        if (read && resource === 'replay') { sendJson(response, 200, manager.getReplay(id), head); return; }
        if (read && resource === 'journal') {
          response.setHeader('Content-Disposition', 'attachment; filename="' + id + '-journal.json"');
          sendJson(response, 200, manager.getJournal(id), head);
          return;
        }
        if (read && resource === 'events') {
          if (head) { manager.get(id); response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' }).end(); }
          else watchRoom(manager, id, response);
          return;
        }
        if (request.method === 'POST' && resource === 'control' && !playerId) {
          const body = await readBody(request);
          if (typeof body.action !== 'string') throw new RoomError(400, 'Invalid control action');
          sendJson(response, 200, await manager.control(id, body.action));
          return;
        }
        if (request.method === 'POST' && resource === 'players' && !playerId) {
          const body = await readBody(request);
          sendJson(response, 200, manager.join(id, body as unknown as Parameters<RoomManager['join']>[1]));
          return;
        }
        if (request.method === 'DELETE' && resource === 'players' && playerId) {
          await readBody(request);
          sendJson(response, 200, manager.leave(id, playerId));
          return;
        }
        response.setHeader('Allow', resource === 'control' || resource === 'players' ? 'POST' : 'GET, HEAD');
        throw new RoomError(405, 'Method not allowed');
      }
      if (!read) throw new RoomError(405, 'Method not allowed');
      const roomPage = pathname.match(/^\/rooms\/([a-zA-Z0-9_-]+)\/?$/);
      const gamePage = pathname.match(/^\/games\/(game_[a-f0-9]{12}_[1-9][0-9]*)\/?$/);
      if (roomPage) manager.get(roomPage[1]);
      if (gamePage) manager.getGameRecord(gamePage[1]);
      const asset = assets.get(pathname);
      if (asset) {
        const source = resolve(webRoot, asset[0]);
        const target = pathname.startsWith('/avatars/') && !existsSync(source) ? resolve(process.cwd(), 'dist/client', pathname.slice(1)) : source;
        const content = await readFile(target);
        response.writeHead(200, { 'Content-Type': asset[1] === 'image/png' ? asset[1] : asset[1] + '; charset=utf-8' });
        response.end(head ? undefined : content);
        return;
      }
      if (options.frontendMiddleware) {
        options.frontendMiddleware(request, response, () => sendJson(response, 404, { error: 'Not found' }, head));
        return;
      }
      const page = pathname === '/' || pathname === '/index.html' || roomPage || gamePage;
      const bundledAsset = pathname.match(/^\/assets\/([a-zA-Z0-9_.-]+\.(js|css|woff2|woff))$/);
      if (!page && !bundledAsset) throw new RoomError(404, 'Not found');
      const builtIndex = resolve(process.cwd(), 'dist/client/index.html');
      const target = page ? existsSync(builtIndex) ? builtIndex : resolve(process.cwd(), 'client/index.html') : resolve(process.cwd(), 'dist/client/assets', bundledAsset![1]);
      if (!existsSync(target)) throw new RoomError(404, 'Not found');
      const content = await readFile(target);
      const type = page ? 'text/html; charset=utf-8' : bundledAsset![2] === 'js' ? 'text/javascript; charset=utf-8' : bundledAsset![2] === 'css' ? 'text/css; charset=utf-8' : 'font/' + bundledAsset![2];
      if (bundledAsset && ['woff', 'woff2'].includes(bundledAsset[2])) response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      response.writeHead(200, { 'Content-Type': type });
      response.end(head ? undefined : content);
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      const status = error instanceof RoomError ? error.statusCode : 500;
      sendJson(response, status, { error: error instanceof RoomError ? error.message : 'Unable to process the request' }, request.method === 'HEAD');
    }
  });
  const close = server.close.bind(server);
  server.close = (callback) => { analysis.dispose(); manager.dispose(); return close(callback); };
  server.on('close', () => { analysis.dispose(); manager.dispose(); });
  return server;
}

