import { ApiParam } from '@nestjs/swagger';

/**
 * Documents a path parameter that holds a MongoDB id. Without it, the Swagger plugin sees the
 * handler's `Types.ObjectId` type and writes an empty object schema, so the spec would tell an
 * agent to send `{}` instead of a 24-character hex string.
 */
export function ApiObjectIdParam(name: string) {
  return ApiParam({
    name,
    description: 'Database id: 24 hexadecimal characters.',
    type: String,
  });
}
