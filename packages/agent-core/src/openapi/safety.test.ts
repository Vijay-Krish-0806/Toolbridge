/**
 * Security regression tests for generated-tool HTTP calls: which addresses are refused (SSRF), and
 * that model-chosen path values cannot change which URL is called. Kept as tests because a
 * mistake here is silent: the call would just go somewhere it should not.
 */
import type { Binding } from '@toolbridge/spec-compiler';
import { describe, expect, it } from 'vitest';

import { isBlockedAddress } from './http-client.js';
import { buildRequest } from './request.js';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fd12::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    'not-an-ip',
  ])('refuses %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '140.82.112.3', '2001:4860:4860::8888', '::ffff:8.8.8.8'])(
    'allows public %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe('buildRequest path safety', () => {
  const binding: Binding = {
    operationId: 'getOrder',
    method: 'get',
    path: '/orders/{id}',
    security: [],
    args: { id: { in: 'path', name: 'id' } },
    requiredArgs: ['id'],
  };
  const base = new URL('https://api.example.com/v1');

  it('keeps the base prefix and encodes slashes inside one segment', () => {
    const request = buildRequest(binding, { id: '../../admin?x=1#y' }, base);
    expect(request.url.href).toBe('https://api.example.com/v1/orders/..%2F..%2Fadmin%3Fx%3D1%23y');
  });

  it.each(['..', '.', ''])('refuses the path value %j', (id) => {
    expect(() => buildRequest(binding, { id }, base)).toThrow(/Refused path value/);
  });

  it('refuses a missing path argument', () => {
    expect(() => buildRequest(binding, {}, base)).toThrow(/Missing a path argument/);
  });
});
