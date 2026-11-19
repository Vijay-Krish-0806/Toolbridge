/**
 * Gets a tenant's spec document, from an upload or from a URL. A URL is fetched with the SSRF-safe
 * client from Step 2.3 (private addresses refused inside DNS lookup, so DNS rebinding cannot get
 * around it; redirects never followed, so a public URL cannot bounce to a private one), with the
 * platform's own allowlist, a size limit and a timeout. Tenants cannot change any of these.
 */
import { UnprocessableEntityException } from '@nestjs/common';
import { type SafeHttpClient, ToolExecutionError } from '@toolbridge/agent-core';

import type { SpecSourceKind } from '../domain/models.js';

export interface SpecInput {
  url?: string;
  document?: Record<string, unknown>;
}

export interface LoadedSpec {
  document: Record<string, unknown>;
  source: { kind: SpecSourceKind; url: string | null };
}

/**
 * Returns the document to compile. Exactly one of `url` or `document` must be given.
 * Errors are 422 with a message the tenant can act on.
 */
export async function loadSpecInput(
  input: SpecInput,
  client: SafeHttpClient,
  timeoutMs: number,
): Promise<LoadedSpec> {
  if ((input.url === undefined) === (input.document === undefined)) {
    throw new UnprocessableEntityException('Send exactly one of "url" or "document".');
  }
  if (input.document !== undefined) {
    return { document: input.document, source: { kind: 'upload', url: null } };
  }
  const url = input.url ?? '';
  return { document: await fetchSpec(url, client, timeoutMs), source: { kind: 'url', url } };
}

/** Downloads and parses a JSON spec. Every refusal or failure becomes a clear 422. */
async function fetchSpec(
  url: string,
  client: SafeHttpClient,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new UnprocessableEntityException('The spec URL is not a valid URL.');
  }

  let text: string;
  try {
    const response = await client.send(
      { method: 'GET', url: parsedUrl, headers: { accept: 'application/json' } },
      AbortSignal.timeout(timeoutMs),
    );
    if (response.status !== 200) {
      throw new UnprocessableEntityException(
        `Fetching the spec failed with HTTP ${String(response.status)}.`,
      );
    }
    text = response.text;
  } catch (error) {
    if (error instanceof UnprocessableEntityException) throw error;
    if (error instanceof ToolExecutionError) {
      throw new UnprocessableEntityException(`Could not fetch the spec: ${error.message}`);
    }
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new UnprocessableEntityException(
        `Fetching the spec timed out after ${String(timeoutMs)} ms.`,
      );
    }
    throw error;
  }

  try {
    const document: unknown = JSON.parse(text);
    if (typeof document !== 'object' || document === null || Array.isArray(document)) {
      throw new Error('not an object');
    }
    return document as Record<string, unknown>;
  } catch {
    throw new UnprocessableEntityException('The spec must be a JSON document (YAML is not supported yet).');
  }
}
