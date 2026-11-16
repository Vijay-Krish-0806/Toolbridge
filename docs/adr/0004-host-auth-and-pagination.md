# ADR-0004: Host store auth with @nestjs/jwt guards, and page-number pagination

- **Status:** Accepted
- **Date:** 2026-11-16

## Context

The host store API needs staff login with three roles (owner, support, warehouse), with access enforced per endpoint, so ToolBridge can later be tested against real 401 and 403 responses. The OpenAPI document must state which roles may call each operation, because ToolBridge will read it. List endpoints need pagination that agents can use without extra state.

NestJS 12's documentation now presents authentication and authorization through the new `@nestjs/authentication` (0.1.6) and `@nestjs/authorization` (0.1.4) packages, first published in September 2026.

## Decision

The API signs and verifies HS256 JWTs with `@nestjs/jwt` 12.0.5 and enforces access with two global guards written in the app: `AuthGuard` (valid token, else 401; opt out with `@Public()`) and `RolesGuard` (role listed in `@Roles(...)`, else 403). A single `@Endpoint()` decorator applies the role rule and the Swagger text from the same value. Lists use `?page` and `?limit` (default 20, maximum 100) and return `{ items, page, limit, total }`.

## Alternatives considered

### `@nestjs/authentication` and `@nestjs/authorization`

- The newest official approach, with policy classes and `@Can()`.
- Not chosen: both are pre-1.0, so their APIs may change, and they hide the token and role checks this project is meant to teach.

### Passport (`@nestjs/passport` with `passport-jwt`)

- The long-standing NestJS pattern.
- Not chosen: two extra dependencies and a strategy layer that adds nothing for a single bearer-token scheme.

### Cursor pagination

- Pages by "items after this id": stable while data changes and fast at any depth.
- Not chosen for now: the store holds about 500 orders, and page numbers are easier for agents and people to reason about. Skip-based paging slows down and can skip or repeat rows on large, changing collections.

## Consequences

**Positive**

- Every route is protected by default. A new route without `@Public()` cannot be left open by mistake.
- Role rules and their documentation cannot drift apart.
- Login, tokens and role checks are plain, readable code.

**Negative**

- The app owns about 100 lines of auth code, including password hashing (Node's built-in scrypt).
- Tokens cannot be revoked before they expire (1 hour). There is no refresh token or logout.
- The seed derives password salts from the seed number to stay repeatable. Acceptable for development data only.
- Page-number pagination would need to change if the data grew large.

**Follow-ups**

- Step 0.3b: role-by-role 403 checks for the write endpoints.
- Revisit `@nestjs/authentication` when it reaches 1.0.

## References

- NestJS migration guide (v12): https://docs.nestjs.com/migration-guide
- NestJS authentication: https://docs.nestjs.com/security/authentication
- NestJS OpenAPI introduction: https://docs.nestjs.com/openapi/introduction
- NestJS validation: https://docs.nestjs.com/techniques/validation
