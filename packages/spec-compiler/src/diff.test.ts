/**
 * Step 2.4 acceptance check: the diff rules. Each test changes one thing in a small spec and checks
 * both the reported change and its breaking flag. These rules decide whether a spec update can be
 * applied without breaking agents, so each one is pinned by a test.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access --
   Fixtures are free-form JSON specs edited in place; typing every nested path would only add noise. */
import { describe, expect, it } from 'vitest';

import { diffModels, type SpecDiff } from './diff.js';
import type { OpenApi3Document } from './load.js';
import type { ApiModel } from './model.js';
import { normalize } from './normalize.js';

type Json = Record<string, any>;

/** A small API: GET /orders/{id} and POST /refunds, each with a request and a response schema. */
function baseSpec(): Json {
  return {
    openapi: '3.0.3',
    info: { title: 'Shop', version: '1' },
    paths: {
      '/orders/{id}': {
        get: {
          operationId: 'getOrder',
          security: [{ bearer: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            {
              name: 'expand',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['items', 'customer'] },
            },
          ],
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      number: { type: 'string' },
                      status: { type: 'string', enum: ['paid', 'shipped'] },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/refunds': {
        post: {
          operationId: 'requestRefund',
          security: [{ bearer: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['orderId', 'amountCents'],
                  properties: {
                    orderId: { type: 'string' },
                    amountCents: { type: 'integer' },
                    note: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { '201': { description: 'created' } },
        },
      },
    },
  };
}

/** Normalizes a fixture spec into the IR that diffModels compares. */
function model(spec: Json): ApiModel {
  return normalize(spec as OpenApi3Document).model;
}

/** Diffs the base spec against a copy changed by `edit`. */
function diffAfter(edit: (spec: Json) => void): SpecDiff {
  const after = baseSpec();
  edit(after);
  return diffModels(model(baseSpec()), model(after));
}

/** All change messages with their breaking flag, for compact assertions. */
function changes(diff: SpecDiff): { breaking: boolean; message: string }[] {
  return diff.changed.flatMap((c) => c.changes);
}

const getOrder = (s: Json): Json => s.paths['/orders/{id}'].get as Json;
const refund = (s: Json): Json => s.paths['/refunds'].post as Json;
const refundSchema = (s: Json): Json =>
  refund(s).requestBody.content['application/json'].schema as Json;
const orderSchema = (s: Json): Json =>
  getOrder(s).responses['200'].content['application/json'].schema as Json;

describe('diffModels', () => {
  it('reports nothing for identical specs', () => {
    expect(diffAfter(() => undefined)).toEqual({
      added: [],
      removed: [],
      changed: [],
      breaking: false,
    });
  });

  it('an added operation is not breaking', () => {
    const diff = diffAfter((s) => {
      s.paths['/coupons'] = {
        get: { operationId: 'listCoupons', responses: { '200': { description: 'ok' } } },
      };
    });
    expect(diff.added).toEqual([{ id: 'listCoupons', method: 'GET', path: '/coupons' }]);
    expect(diff.breaking).toBe(false);
  });

  it('a removed operation is breaking', () => {
    const diff = diffAfter((s) => {
      delete s.paths['/refunds'];
    });
    expect(diff.removed).toEqual([{ id: 'requestRefund', method: 'POST', path: '/refunds' }]);
    expect(diff.breaking).toBe(true);
  });

  it('a renamed path parameter is one changed operation, not a removal plus an addition', () => {
    const diff = diffAfter((s) => {
      getOrder(s).parameters[0].name = 'orderId';
      s.paths['/orders/{orderId}'] = s.paths['/orders/{id}'];
      delete s.paths['/orders/{id}'];
    });
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(changes(diff)).toEqual([
      { breaking: true, message: 'path parameter "id" removed' },
      { breaking: true, message: 'path parameter "orderId" added as required' },
    ]);
  });

  it('a changed operationId is breaking (the tool name changes)', () => {
    const diff = diffAfter((s) => {
      getOrder(s).operationId = 'fetchOrder';
    });
    expect(changes(diff)).toEqual([
      {
        breaking: true,
        message: 'operationId "getOrder" -> "fetchOrder" (the generated tool name changes)',
      },
    ]);
  });

  it('a new required parameter is breaking, a new optional one is not', () => {
    const required = diffAfter((s) => {
      getOrder(s).parameters.push({
        name: 'tenant',
        in: 'query',
        required: true,
        schema: { type: 'string' },
      });
    });
    const optional = diffAfter((s) => {
      getOrder(s).parameters.push({ name: 'tenant', in: 'query', schema: { type: 'string' } });
    });
    expect(changes(required)).toEqual([
      { breaking: true, message: 'query parameter "tenant" added as required' },
    ]);
    expect(changes(optional)).toEqual([
      { breaking: false, message: 'query parameter "tenant" added' },
    ]);
  });

  it('optional -> required is breaking, required -> optional is not', () => {
    const tightened = diffAfter((s) => {
      getOrder(s).parameters[1].required = true;
    });
    const loosened = diffAfter((s) => {
      refundSchema(s).required = ['orderId'];
    });
    expect(changes(tightened)).toEqual([
      { breaking: true, message: 'query parameter "expand" is now required' },
    ]);
    expect(changes(loosened)).toEqual([]); // a body field becoming optional needs no report
  });

  it('a type change is breaking (the host fix of Step 2.2: object -> integer)', () => {
    const diff = diffAfter((s) => {
      getOrder(s).parameters[1].schema = { type: 'integer' };
    });
    expect(changes(diff)).toEqual([
      { breaking: true, message: 'query parameter "expand": type string -> integer' },
    ]);
  });

  it('request side: removing an enum value is breaking, adding one is not', () => {
    const removed = diffAfter((s) => {
      getOrder(s).parameters[1].schema.enum = ['items'];
    });
    const added = diffAfter((s) => {
      getOrder(s).parameters[1].schema.enum = ['items', 'customer', 'shipment'];
    });
    expect(changes(removed)).toEqual([
      { breaking: true, message: 'query parameter "expand": enum values removed "customer"' },
    ]);
    expect(changes(added)).toEqual([
      { breaking: false, message: 'query parameter "expand": enum values added "shipment"' },
    ]);
  });

  it('request body: new required field and removed field are breaking, new optional field is not', () => {
    const diff = diffAfter((s) => {
      const schema = refundSchema(s);
      schema.properties.reason = { type: 'string' };
      schema.properties.channel = { type: 'string' };
      schema.required.push('reason');
      delete schema.properties.note;
    });
    expect(changes(diff)).toEqual([
      { breaking: true, message: 'body.note removed' },
      { breaking: true, message: 'body.reason added as required' },
      { breaking: false, message: 'body.channel added' },
    ]);
  });

  it('response: a removed field is breaking, an added field or enum value is not', () => {
    const diff = diffAfter((s) => {
      const schema = orderSchema(s);
      delete schema.properties.number;
      schema.properties.placedAt = { type: 'string' };
      schema.properties.status.enum.push('delivered');
    });
    expect(changes(diff)).toEqual([
      { breaking: true, message: 'response.number removed' },
      { breaking: false, message: 'response.status: enum values added "delivered"' },
      { breaking: false, message: 'response.placedAt added' },
    ]);
  });

  it('auth: newly required is breaking, removed is not', () => {
    const added = diffAfter((s) => {
      s.paths['/coupons'] = { get: { responses: { '200': { description: 'ok' } } } };
    });
    expect(added.breaking).toBe(false);

    const removed = diffAfter((s) => {
      getOrder(s).security = [];
    });
    expect(changes(removed)).toEqual([{ breaking: false, message: 'no longer requires auth' }]);

    const before = baseSpec();
    getOrder(before).security = [];
    const now = diffModels(model(before), model(baseSpec()));
    expect(now.changed.flatMap((c) => c.changes)).toEqual([
      { breaking: true, message: 'now requires auth' },
    ]);
  });

  it('deprecation is reported but not breaking', () => {
    const diff = diffAfter((s) => {
      getOrder(s).deprecated = true;
    });
    expect(changes(diff)).toEqual([{ breaking: false, message: 'now deprecated' }]);
    expect(diff.breaking).toBe(false);
  });
});
