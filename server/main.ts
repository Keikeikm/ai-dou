import { createReplayServer } from './http/replay-server.js';
import { loadReplayEnvironment, serverConfiguration } from './config/environment.js';
import type { ViteDevServer } from 'vite';

loadReplayEnvironment();
let port = Number(process.env.PORT ?? 5173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
const development = !process.argv.includes('--production');
let vite: ViteDevServer | undefined;
const server = createReplayServer({ ...serverConfiguration(), frontendMiddleware: development ? (request, response, next) => vite ? vite.middlewares(request, response, next) : next() : undefined });
if (development) vite = await (await import('vite')).createServer({ server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
server.on('error', (error: NodeJS.ErrnoException) => {
  if (development && process.env.PORT === undefined && error.code === 'EADDRINUSE' && port < 65535) {
    console.log('Port ' + port + ' is already in use; trying ' + (port + 1));
    server.listen(++port, '127.0.0.1');
    return;
  }
  console.error(error.code === 'EADDRINUSE'
    ? 'Unable to start AI DOU: port ' + port + ' is already in use. Stop the existing service or set PORT to a free port.'
    : 'Unable to start AI DOU: ' + error.message);
  void vite?.close();
  process.exitCode = 1;
});
server.on('listening', () => console.log('AI DOU React room: http://127.0.0.1:' + port));
server.listen(port, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { server.close(); server.closeAllConnections(); void vite?.close(); });
