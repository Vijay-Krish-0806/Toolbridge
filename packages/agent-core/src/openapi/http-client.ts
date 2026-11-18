/**
 * An HTTP client that is safe to point at URLs built from a spec and model-chosen arguments.
 *
 * SSRF (server-side request forgery): if a tool can be made to call http://169.254.169.254/ or
 * http://10.0.0.5/admin, the agent becomes a way into the private network. This client:
 * - allows only http and https;
 * - refuses private, loopback, link-local and other special addresses, unless the host name is
 *   explicitly allowlisted (our local host API on 127.0.0.1 is);
 * - checks the address inside DNS lookup, on its own connection pool, so the address that is
 *   checked is the address that is connected to (no DNS-rebinding gap, no reused unchecked socket);
 * - never follows redirects, and caps the response size.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

import { ToolExecutionError } from '../tools/errors.js';
import type { HttpRequest } from './request.js';

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

export interface SafeHttpClientOptions {
  /** Host names allowed to resolve to private addresses, for example ['127.0.0.1', 'localhost']. */
  allowPrivateHosts?: string[];
  /** Largest response body accepted. Default 5 MiB. */
  maxResponseBytes?: number;
}

/** Addresses no tool may reach: private networks, loopback, link-local (cloud metadata), and reserved ranges. */
function createBlockList(): BlockList {
  const list = new BlockList();
  const v4: [string, number][] = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];
  const v6: [string, number][] = [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b::', 96],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ];
  for (const [net, prefix] of v4) list.addSubnet(net, prefix, 'ipv4');
  for (const [net, prefix] of v6) list.addSubnet(net, prefix, 'ipv6');
  return list;
}

const BLOCKED = createBlockList();

/** Raised inside the DNS lookup when an address is refused, so the request fails before connecting. */
class BlockedAddressError extends Error {
  override readonly name = 'BlockedAddressError';
}

/**
 * True if the address is in a refused range. IPv4-mapped IPv6 (`::ffff:10.0.0.1`) is checked
 * against the IPv4 rules too, as Node's BlockList documents.
 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family === 6) return BLOCKED.check(address, 'ipv6');
  return true; // not an IP at all: refuse
}

/**
 * A DNS lookup that refuses blocked addresses. Node calls it for every new connection; with
 * `all: true` (Node's default for "happy eyeballs") it must answer with a list.
 * If any resolved address is blocked, the whole name is refused: a name that mixes public and
 * private addresses is suspicious.
 */
const checkedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) {
      callback(error, '', 4);
      return;
    }
    const bad = addresses.find((a) => isBlockedAddress(a.address));
    if (bad !== undefined) {
      callback(
        new BlockedAddressError(`${hostname} resolves to a private address (${bad.address})`),
        '',
        4,
      );
      return;
    }
    if (options.all === true) {
      (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
    } else {
      const first = addresses[0];
      if (first === undefined) callback(new Error(`No address for ${hostname}`), '', 4);
      else callback(null, first.address, first.family);
    }
  });
};

export class SafeHttpClient {
  private readonly allowPrivate: Set<string>;
  private readonly maxResponseBytes: number;
  // Separate pools: allowlisted hosts use normal DNS, everything else the checking lookup.
  // Keeping them apart means a socket opened without checks is never reused for another host.
  private readonly agents: Record<'checked' | 'trusted', { http: http.Agent; https: https.Agent }>;

  /** Creates the client and its connection pools; call close() when done to free sockets. */
  constructor(options: SafeHttpClientOptions = {}) {
    this.allowPrivate = new Set((options.allowPrivateHosts ?? []).map((h) => h.toLowerCase()));
    this.maxResponseBytes = options.maxResponseBytes ?? 5 * 1024 * 1024;
    this.agents = {
      checked: {
        http: new http.Agent({ keepAlive: true, lookup: checkedLookup }),
        https: new https.Agent({ keepAlive: true, lookup: checkedLookup }),
      },
      trusted: {
        http: new http.Agent({ keepAlive: true }),
        https: new https.Agent({ keepAlive: true }),
      },
    };
  }

  /**
   * Sends one request and returns status, headers and body text. Throws ToolExecutionError:
   * `blocked` for refused destinations and redirects, `network` (retryable) when the server
   * cannot be reached, `http_error` for oversized responses. An abort is re-thrown unchanged.
   */
  async send(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
    const { url } = request;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ToolExecutionError(
        'blocked',
        `Refused: only http and https URLs are allowed (${url.protocol}).`,
      );
    }
    // URL keeps IPv6 literals in brackets; DNS lookup is skipped for IP literals, so check them here.
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const trusted = this.allowPrivate.has(host);
    if (!trusted && isIP(host) !== 0 && isBlockedAddress(host)) {
      throw new ToolExecutionError('blocked', `Refused: ${host} is a private or reserved address.`);
    }

    const pool = this.agents[trusted ? 'trusted' : 'checked'];
    const response = await this.exchange(
      request,
      url.protocol === 'https:' ? pool.https : pool.http,
      signal,
    );
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location ?? 'unknown';
      throw new ToolExecutionError(
        'blocked',
        `Refused to follow a redirect (HTTP ${String(response.status)}) to ${location}.`,
        {
          status: response.status,
        },
      );
    }
    return response;
  }

  /** Frees the pooled sockets. */
  close(): void {
    for (const pool of Object.values(this.agents)) {
      pool.http.destroy();
      pool.https.destroy();
    }
  }

  /** Performs the raw request with node:http(s), collecting the body up to the size cap. */
  private exchange(
    request: HttpRequest,
    agent: http.Agent,
    signal: AbortSignal | undefined,
  ): Promise<HttpResponse> {
    const transport = request.url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = transport.request(
        request.url,
        { method: request.method, headers: request.headers, agent, ...(signal && { signal }) },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > this.maxResponseBytes) {
              req.destroy(
                new ToolExecutionError(
                  'http_error',
                  `Response is larger than ${String(this.maxResponseBytes)} bytes; refused.`,
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              text: Buffer.concat(chunks).toString('utf8'),
            });
          });
          res.on('error', reject);
        },
      );
      req.on('error', (error) => {
        reject(this.classify(error, request.url, signal));
      });
      if (request.body !== undefined) req.write(request.body);
      req.end();
    });
  }

  /** Maps a low-level failure to a ToolExecutionError the model can act on. */
  private classify(error: Error, url: URL, signal: AbortSignal | undefined): Error {
    // On abort, re-throw the reason (the executor's timeout error) so it reports its own timeout.
    if (signal?.aborted) return signal.reason instanceof Error ? signal.reason : error;
    if (error instanceof ToolExecutionError) return error;
    if (error instanceof BlockedAddressError) {
      return new ToolExecutionError('blocked', `Refused: ${error.message}.`);
    }
    return new ToolExecutionError('network', `Could not reach ${url.origin}: ${error.message}`, {
      retryable: true,
    });
  }
}
