/**
 * Marks a branch that must be unreachable. Call it in the `default` of a switch over a union:
 * if a new member is added and not handled, the call stops compiling because the value is no
 * longer `never`. At runtime it throws, in case untyped data reaches it.
 */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}
