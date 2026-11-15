# ADR-0002: Pin TypeScript 6.0 until typed linting supports 7

- **Status:** Accepted
- **Date:** 2026-11-15

## Context

On 2026-11-15 the npm `latest` tag for `typescript` is 7.0.2. The project uses typed linting with `typescript-eslint` 8.72.2 (rules such as `no-floating-promises`, which need type information). That release declares the peer dependency `typescript: ">=4.8.4 <6.1.0"`, so TypeScript 7 is outside its supported range. The newest supported release is TypeScript 6.0.3.

## Decision

The repository pins `typescript` to 6.0.3 (exact version) and keeps typed linting with `typescript-eslint`'s `strictTypeChecked` config.

## Alternatives considered

### TypeScript 7 with typed linting anyway

- Install 7.0.2 and ignore the peer dependency warning.
- Not chosen: the combination is unsupported, so lint failures or missed errors would be hard to tell apart from real problems.

### TypeScript 7 without typed linting

- Use only syntax-level lint rules.
- Not chosen: the type-aware rules (unhandled promises, unsafe `any`) catch the bugs most likely in an async agent runtime.

## Consequences

**Positive**

- Every tool in the chain runs inside its supported version range.

**Negative**

- The project is one major version behind on the compiler, and may miss TypeScript 7's faster compiler and any new checks.

**Follow-ups**

- Revisit when `typescript-eslint` declares support for TypeScript 7. Check its peer dependency with `npm view typescript-eslint peerDependencies`.

## References

- `npm view typescript-eslint@8.72.2 peerDependencies` (output on 2026-11-15).
