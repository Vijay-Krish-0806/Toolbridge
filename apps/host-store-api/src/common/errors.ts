import { ConflictException, NotFoundException } from '@nestjs/common';

/** MongoDB's error code for a unique-index violation. */
const DUPLICATE_KEY = 11000;

export function isDuplicateKey(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === DUPLICATE_KEY;
}

/**
 * A conditional update ("change it only if it is still pending") matched nothing. That has two
 * possible causes, and callers need to know which: the record does not exist (404), or it is in
 * the wrong state for this action (409 Conflict).
 */
export function notFoundOrConflict(
  found: { status: string } | null,
  what: string,
  rule: string,
): NotFoundException | ConflictException {
  return found
    ? new ConflictException(`${what} is ${found.status}. ${rule}`)
    : new NotFoundException(`${what} does not exist.`);
}
