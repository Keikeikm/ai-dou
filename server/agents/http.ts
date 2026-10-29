import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { AgentProtocolError, createAgentRequest, parseAgentResponse } from './protocol.js';
import type { GameState } from '../game/game.js';
import type { DecisionAgent, DecisionContext } from '../rooms/scheduler.js';

export class AgentEndpointError extends Error {}

export class AgentHttpError extends Error {
  constructor(readonly statusCode: number) { super('Agent returned HTTP ' + statusCode); }
}

export class AgentTransportError extends Error {
  constructor(readonly code: 'dns_failed' | 'tls_failed' | 'connection_failed' | 'response_failed' | 'cancelled') { super('Agent transport: ' + code); }
}

export function transportError(error: unknown, signal: AbortSignal, phase: 'dns' | 'connection' | 'response'): AgentTransportError {
  if (signal.aborted) return new AgentTransportError('cancelled');
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const tls = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code);
  return new AgentTransportError(tls ? 'tls_failed' : phase === 'dns' ? 'dns_failed' : phase === 'response' ? 'response_failed' : 'connection_failed');
}

export interface AgentCredentials {
  readonly apiUrl: string;
  readonly apiKey: string | undefined;
}

export function normalizeApiKey(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(value)) throw new AgentEndpointError('API key must be 1-2048 printable ASCII characters without spaces');
  return value;
}

function loopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function isPublicAgentAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [first, second, third] = address.split('.').map(Number);
    return !(first === 0 || first === 10 || first === 127 || first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) || (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && (second === 168 || second === 0 || (second === 88 && third === 99))) ||
      (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) ||
      (first === 203 && second === 0 && third === 113));
  }
  if (isIP(address) !== 6 || !/^[23][0-9a-f]{3}:/i.test(address)) return false;
  const [first, second] = address.toLowerCase().split(':');
  const subnet = parseInt(second || '0', 16);
  return first !== '2002' && first !== '3fff' && !(first === '2001' && (subnet === 0xdb8 || subnet < 0x200));
}

export class AgentEndpointPolicy {
  private readonly origins = new Set<string>();

  constructor(origins: readonly string[] = [], private readonly resolveHost: typeof lookup = lookup) {
    for (const origin of origins) {
      const url = this.parse(origin);
      if (url.pathname !== '/' || url.search || url.hash) throw new AgentEndpointError('Allowed Agent origins must not contain a path or query');
      this.origins.add(url.origin);
    }
  }

  validate(value: unknown): string {
    const url = this.parse(value);
    if (!this.origins.has(url.origin)) throw new AgentEndpointError('Agent origin is not allowlisted; configure AGENT_ALLOWED_ORIGINS on the server');
    return url.href;
  }

  async resolve(value: string, signal: AbortSignal): Promise<{ url: URL; address: string; family: number }> {
    const url = new URL(this.validate(value));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    signal.throwIfAborted();
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await this.resolveHost(host, { all: true, verbatim: true });
    signal.throwIfAborted();
    if (!addresses.length || addresses.some(({ address }) => loopbackHost(host) ? address !== '127.0.0.1' && address !== '::1' : !isPublicAgentAddress(address))) {
      throw new Error('Agent endpoint resolved to a prohibited address');
    }
    return { url, ...addresses[0] };
  }

  private parse(value: unknown): URL {
    if (typeof value !== 'string' || value.length > 2048) throw new AgentEndpointError('Invalid Agent URL');
    let url: URL;
    try { url = new URL(value); } catch { throw new AgentEndpointError('Invalid Agent URL'); }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackHost(host))) ||
      (isIP(host) && !loopbackHost(host) && !isPublicAgentAddress(host))) {
      throw new AgentEndpointError('Agent URL requires public HTTPS or explicitly allowlisted loopback HTTP, without userinfo, query or fragment');
    }
    return url;
  }
}

export async function requestAgentJson(policy: AgentEndpointPolicy, credentials: AgentCredentials, value: unknown, signal: AbortSignal, maxBytes = 16384): Promise<unknown> {
  let target: Awaited<ReturnType<AgentEndpointPolicy['resolve']>>;
  try { target = await policy.resolve(credentials.apiUrl, signal); }
  catch (error) { throw transportError(error, signal, 'dns'); }
  return new Promise<unknown>((resolveResponse, rejectResponse) => {
    const body = Buffer.from(JSON.stringify(value));
    const hostname = target.url.hostname.replace(/^\[|\]$/g, '');
    const send = target.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const outbound = send({
      hostname: target.address, family: target.family, port: target.url.port || (target.url.protocol === 'https:' ? 443 : 80),
      ...(target.url.protocol === 'https:' && !isIP(hostname) ? { servername: hostname } : {}),
      path: target.url.pathname, method: 'POST', agent: false, signal,
      headers: { Host: target.url.host, 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': body.length,
        ...(credentials.apiKey ? { Authorization: 'Bearer ' + credentials.apiKey } : {}) },
    }, (incoming) => {
      if (incoming.statusCode !== 200) { rejectResponse(new AgentHttpError(incoming.statusCode ?? 0)); incoming.destroy(); return; }
      if (!/^application\/json(?:\s*;|$)/i.test(incoming.headers['content-type'] ?? '')) {
        rejectResponse(new AgentProtocolError('Agent response must use application/json')); incoming.destroy(); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { rejectResponse(new AgentProtocolError('Agent response exceeds ' + maxBytes + ' bytes')); incoming.destroy(); }
        else chunks.push(chunk);
      });
      incoming.on('error', (error) => rejectResponse(transportError(error, signal, 'response')));
      incoming.on('end', () => {
        try { resolveResponse(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { rejectResponse(new AgentProtocolError('Agent returned malformed JSON')); }
      });
    });
    outbound.on('error', (error) => rejectResponse(transportError(error, signal, 'connection')));
    outbound.end(body);
  });
}

export class HttpDecisionAgent implements DecisionAgent {
  readonly kind = 'http';
  constructor(readonly name: string, private readonly policy: AgentEndpointPolicy, private readonly credentials: () => AgentCredentials | undefined,
    private readonly roomId: string, private readonly generation: number) {}

  async decide(state: GameState, context: DecisionContext) {
    const credentials = this.credentials();
    if (!credentials) throw new Error('Agent credentials are no longer available');
    const request = createAgentRequest(state, { roomId: this.roomId, generation: this.generation, round: context.sequence, deadline: context.deadline });
    const response = await requestAgentJson(this.policy, credentials, request, context.signal);
    return parseAgentResponse(response, request, state);
  }
}
