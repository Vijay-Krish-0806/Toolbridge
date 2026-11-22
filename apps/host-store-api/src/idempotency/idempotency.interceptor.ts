import { createHash } from 'node:crypto';

import {
  type CallHandler,
  ConflictException,
  type ExecutionContext,
  HttpException,
  Injectable,
  type NestInterceptor,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import { catchError, from, map, type Observable, of, switchMap, throwError } from 'rxjs';

import type { AuthUser } from '../auth/auth.decorators.js';
import type { IdempotencyRecord } from '../domain/idempotency.schema.js';
import { MODEL } from '../domain/models.js';

/** The request header. The same name Stripe and the IETF draft use. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KEY_PATTERN = /^[\w.:-]{1,200}$/;
const TTL_MS = 24 * 60 * 60 * 1000;

interface HttpRequest {
  method: string;
  originalUrl: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  user?: AuthUser;
}
interface HttpResponse {
  statusCode: number;
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
}

/**
 * IDEMPOTENCY KEYS for every write route (Step 4.5, ADR 0040). A client that may send the same
 * write twice (a retry after a timeout, a worker that died before it saw the answer) sends an
 * `Idempotency-Key` header; the first request does the work, every repeat gets the stored answer.
 *
 * 1. Reserve: insert `{ key, requestHash, state: 'in_progress' }`. The insert is atomic (unique
 *    id), so of two requests arriving together exactly one wins.
 * 2. The winner runs the route and stores the status and body (2xx and 4xx; a 5xx is not
 *    stored, so the client may try again).
 * 3. A repeat with the same body gets the stored answer (header `Idempotent-Replayed: true`);
 *    while the first is still running, 409 (try again shortly); a different body, 422.
 * Keys are per user and live 24 hours. Requests without the header work as before.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @InjectModel(MODEL.Idempotency.name) private readonly model: Model<IdempotencyRecord>,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<HttpRequest>();
    const res = http.getResponse<HttpResponse>();
    const header = req.headers[IDEMPOTENCY_HEADER];
    const key = Array.isArray(header) ? header[0] : header;
    // Only authenticated writes: a key is scoped to the user who sent it.
    if (!key || !WRITE_METHODS.has(req.method) || !req.user) return next.handle();
    if (!KEY_PATTERN.test(key)) {
      return throwError(
        () => new UnprocessableEntityException('Idempotency-Key: 1 to 200 of [A-Za-z0-9_.:-].'),
      );
    }
    const userId = req.user.id;
    const id = sha256(`${userId}\n${key}`);
    const requestHash = sha256(
      `${req.method}\n${req.originalUrl}\n${JSON.stringify(req.body ?? null)}`,
    );

    return from(this.reserve(id, userId, requestHash)).pipe(
      switchMap((existing) => {
        if (existing) return this.replay(existing, requestHash, res);
        // The route's own status (201 for POST, or its @HttpCode): Nest sets it on the response
        // only when it replies, after this interceptor, so it is read from the route metadata.
        const status =
          this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler()) ??
          (req.method === 'POST' ? 201 : 200);
        return next.handle().pipe(
          // Stored BEFORE the answer leaves, so a repeat right after it already finds the result.
          switchMap((body: unknown) => from(this.finish(id, status, body)).pipe(map(() => body))),
          catchError((error: unknown) => {
            const status = error instanceof HttpException ? error.getStatus() : 500;
            // A client error is an answer too (the same request would fail the same way);
            // a server error is not, so the reservation is dropped and a retry may succeed.
            const settle =
              status < 500 && error instanceof HttpException
                ? this.finish(id, status, error.getResponse())
                : this.model.deleteOne({ _id: id }).exec();
            return from(settle).pipe(switchMap(() => throwError(() => error)));
          }),
        );
      }),
    );
  }

  /** Reserves the key; returns the existing record when someone already holds it. */
  private async reserve(
    id: string,
    userId: string,
    requestHash: string,
  ): Promise<IdempotencyRecord | null> {
    const now = new Date();
    try {
      await this.model.create({
        _id: id,
        userId,
        requestHash,
        state: 'in_progress',
        statusCode: null,
        body: null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + TTL_MS),
      });
      return null;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 11000)) throw error;
      return this.model.findById(id).lean<IdempotencyRecord>().exec();
    }
  }

  /** The answer for a repeated key. */
  private replay(
    record: IdempotencyRecord,
    requestHash: string,
    res: HttpResponse,
  ): Observable<unknown> {
    if (record.requestHash !== requestHash) {
      return throwError(
        () =>
          new UnprocessableEntityException(
            'This Idempotency-Key was already used for a different request.',
          ),
      );
    }
    if (record.state === 'in_progress' || record.statusCode === null) {
      // Retry-After marks this conflict as "ask again shortly", unlike a business conflict.
      res.setHeader('retry-after', '1');
      return throwError(
        () => new ConflictException('A request with this Idempotency-Key is still in progress.'),
      );
    }
    res.setHeader('idempotent-replayed', 'true');
    if (record.statusCode >= 400) {
      return throwError(() => new HttpException(record.body as object, record.statusCode ?? 500));
    }
    res.status(record.statusCode);
    return of(record.body);
  }

  private async finish(id: string, statusCode: number, body: unknown): Promise<void> {
    await this.model
      .updateOne({ _id: id }, { $set: { state: 'completed', statusCode, body } })
      .exec();
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
