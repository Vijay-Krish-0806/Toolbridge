/**
 * Spec lifecycle, limits and SSRF:
 * - re-upload rules: new write tools start disabled, write tools with breaking changes go to
 *   needs_review (disabled), removed tools become inactive and cannot be enabled;
 * - limits: specs per tenant, upload size, duplicate names;
 * - a tenant cannot make the platform fetch from a private address, through a redirect, or wait
 *   forever; the private-address allowlist is platform config ("localhost" here), not tenant input.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { body, createTenant, type Harness, hostSpec, startHarness } from './harness.js';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment --
   test edits free-form JSON specs in place. */

interface Tool {
  name: string;
  enabled: boolean;
  status: string;
}

let h: Harness;
let tenant: { id: string; key: string };
let specServer: Server;
let port: number;

const as = (key: string) => ({
  get: (path: string) => request(h.http).get(path).set('authorization', `Bearer ${key}`),
  post: (path: string) => request(h.http).post(path).set('authorization', `Bearer ${key}`),
  patch: (path: string) => request(h.http).patch(path).set('authorization', `Bearer ${key}`),
});

/** Tools of a spec, by name. */
async function tools(specId: string): Promise<Map<string, Tool>> {
  const list = body<Tool[]>(await as(tenant.key).get(`/specs/${specId}/tools`).expect(200));
  return new Map(list.map((t) => [t.name, t]));
}

beforeAll(async () => {
  h = await startHarness();
  tenant = await createTenant(h.http, 'Lifecycle Co');
  // A local web server standing in for a tenant's public API: /spec serves the host spec,
  // /redirect bounces to a private address, /slow never answers.
  specServer = createServer((req, res) => {
    if (req.url === '/spec') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(hostSpec()));
    } else if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://127.0.0.1:${String(port)}/spec` }).end();
    } else if (req.url !== '/slow') {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => specServer.listen(0, resolve)); // all interfaces, so "localhost" works
  port = (specServer.address() as AddressInfo).port;
});

afterAll(async () => {
  specServer.closeAllConnections();
  specServer.close();
  await h.app.close();
});

describe('re-uploading a spec', () => {
  it('applies the review rules to changed, new and removed tools', async () => {
    const v1 = await as(tenant.key)
      .post('/specs')
      .send({ name: 'store', document: hostSpec() })
      .expect(201);
    const specId = body<{ spec: { id: string } }>(v1).spec.id;
    // The tenant reviews and enables one write tool.
    await as(tenant.key)
      .patch(`/specs/${specId}/tools/orders_update_notes`)
      .send({ enabled: true })
      .expect(200);

    const v2 = hostSpec() as any;
    // Breaking change to that write operation: a new required body field.
    v2.paths['/orders/{id}/notes'].patch.requestBody.content['application/json'].schema = {
      type: 'object',
      required: ['notes', 'editorId'],
      properties: { notes: { type: 'string' }, editorId: { type: 'string' } },
    };
    // A removed operation.
    delete v2.paths['/coupons/{code}/deactivate'];
    // A new write operation.
    v2.paths['/orders/{id}/archive'] = {
      post: {
        operationId: 'OrdersController_archive',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'archived' } },
      },
    };

    const response = await as(tenant.key)
      .post(`/specs/${specId}/versions`)
      .send({ document: v2 })
      .expect(201);
    const result = body<{
      spec: { currentVersion: number };
      version: { diff: { breaking: boolean; removed: number; added: number } };
      tools: { needsReview: string[]; removed: string[]; newWritesDisabled: number };
    }>(response);
    expect(result.spec.currentVersion).toBe(2);
    expect(result.version.diff).toMatchObject({ breaking: true, removed: 1, added: 1 });
    expect(result.tools.needsReview).toEqual(['orders_update_notes']);
    expect(result.tools.removed).toEqual(['coupons_deactivate']);

    const after = await tools(specId);
    expect(after.get('orders_update_notes')).toMatchObject({
      enabled: false,
      status: 'needs_review',
    });
    expect(after.get('coupons_deactivate')).toMatchObject({ enabled: false, status: 'removed' });
    expect(after.get('orders_archive')).toMatchObject({ enabled: false, status: 'active' });
    expect(after.get('orders_list')).toMatchObject({ enabled: true, status: 'active' });

    // A removed tool cannot be enabled; enabling a needs_review tool marks it reviewed.
    await as(tenant.key)
      .patch(`/specs/${specId}/tools/coupons_deactivate`)
      .send({ enabled: true })
      .expect(409);
    const reviewed = await as(tenant.key)
      .patch(`/specs/${specId}/tools/orders_update_notes`)
      .send({ enabled: true })
      .expect(200);
    expect(body<Tool>(reviewed)).toMatchObject({ enabled: true, status: 'active' });

    const history = body<{ versions: { version: number }[] }>(
      await as(tenant.key).get(`/specs/${specId}`).expect(200),
    );
    expect(history.versions.map((v) => v.version)).toEqual([2, 1]);
  });
});

describe('limits', () => {
  it('refuses a duplicate name, too many specs, and an oversized upload', async () => {
    const t = await createTenant(h.http, 'Limits Co');
    await as(t.key).post('/specs').send({ name: 'a', document: hostSpec() }).expect(201);
    await as(t.key).post('/specs').send({ name: 'a', document: hostSpec() }).expect(409);
    await as(t.key).post('/specs').send({ name: 'b', document: hostSpec() }).expect(201);
    await as(t.key).post('/specs').send({ name: 'c', document: hostSpec() }).expect(201);
    const fourth = await as(t.key)
      .post('/specs')
      .send({ name: 'd', document: hostSpec() })
      .expect(409);
    expect(body<{ message: string }>(fourth).message).toContain('limit');

    const huge = { ...hostSpec(), padding: 'x'.repeat(600 * 1024) };
    await as(t.key).post('/specs').send({ name: 'big', document: huge }).expect(413);
  });

  it('refuses a body with both or neither of url and document, and invalid specs', async () => {
    await as(tenant.key).post('/specs').send({ name: 'none' }).expect(422);
    await as(tenant.key)
      .post('/specs')
      .send({ name: 'both', url: 'https://example.com/spec.json', document: hostSpec() })
      .expect(422);
    const bad = await as(tenant.key)
      .post('/specs')
      .send({ name: 'bad', document: { swagger: '2.0' } })
      .expect(422);
    expect(body<{ message: string }>(bad).message).toMatch(/Swagger 2.0|Could not load/);
  });
});

describe('fetching specs by URL (SSRF)', () => {
  it('fetches from a host the platform allowlisted', async () => {
    await as(tenant.key)
      .post('/specs')
      .send({ name: 'by-url', url: `http://localhost:${String(port)}/spec` })
      .expect(201);
  });

  it('refuses private and cloud-metadata addresses that are not allowlisted', async () => {
    for (const url of [
      `http://127.0.0.1:${String(port)}/spec`,
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/spec.json',
      `http://[::1]:${String(port)}/spec`,
    ]) {
      const response = await as(tenant.key).post('/specs').send({ name: 'ssrf', url }).expect(422);
      expect(body<{ message: string }>(response).message).toMatch(
        /private or reserved|resolves to a private/,
      );
    }
  });

  it('never follows a redirect, even from an allowed host to a private one', async () => {
    const response = await as(tenant.key)
      .post('/specs')
      .send({ name: 'redirect', url: `http://localhost:${String(port)}/redirect` })
      .expect(422);
    expect(body<{ message: string }>(response).message).toContain('redirect');
  });

  it('gives up after the fetch timeout', async () => {
    const response = await as(tenant.key)
      .post('/specs')
      .send({ name: 'slow', url: `http://localhost:${String(port)}/slow` })
      .expect(422);
    expect(body<{ message: string }>(response).message).toContain('timed out');
  });

  it('offers tenants no way to change the allowlist', async () => {
    await as(tenant.key)
      .post('/specs')
      .send({
        name: 'sneaky',
        url: `http://127.0.0.1:${String(port)}/spec`,
        allowPrivateHosts: ['127.0.0.1'],
      })
      .expect(400);
  });
});
