/**
 * Session tokens (Step 4.4b, ADR 0036): short-lived JWTs signed with HS256 (jose 6.2.15).
 *
 * A JWT is three base64url parts, `header.payload.signature`. Anyone can READ the payload (it is
 * only encoded), but only the holder of PLATFORM_SESSION_KEY can make a valid signature. So the
 * payload may carry who the user is, but never a secret.
 *
 * Verification is strict on purpose: only HS256 is accepted (a token that says `alg: none` or
 * any other algorithm is refused before its signature is looked at), and the issuer, audience,
 * expiry and every claim we rely on must be present and right.
 */
import { errors, jwtVerify, SignJWT } from 'jose';

export const SESSION_ISSUER = 'toolbridge';
/** The only service that accepts these tokens: the run API. */
export const SESSION_AUDIENCE = 'toolbridge-run-api';
const ALGORITHM = 'HS256';

/** Who a verified token says the caller is. */
export interface SessionClaims {
  /** Token id: the key of the server-side session record (revocation, the host token). */
  jti: string;
  tenantId: string;
  specId: string;
  /** The host user id (`sub`). */
  userId: string;
  role: string;
  expiresAt: Date;
}

/** Thrown for any token that must not be accepted; the reason is for logs, not for callers. */
export class InvalidSessionToken extends Error {
  override readonly name = 'InvalidSessionToken';
}

/**
 * Signs a token.
 * Before -> after: `{ jti, tenantId, specId, userId: 'u1', role: 'support', expiresAt }` ->
 * `'eyJhbGciOiJIUzI1NiJ9.eyJ0ZW4iOi…'` with claims ten, spec, role, sub, jti, iss, aud, iat, exp.
 */
export async function signSessionToken(claims: SessionClaims, key: Uint8Array): Promise<string> {
  return new SignJWT({ ten: claims.tenantId, spec: claims.specId, role: claims.role })
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setSubject(claims.userId)
    .setJti(claims.jti)
    .setIssuedAt()
    .setExpirationTime(claims.expiresAt)
    .sign(key);
}

/**
 * Verifies a token's signature and claims; returns the claims or throws InvalidSessionToken.
 * It does NOT check revocation: that needs the database (SessionsService.resolve does both).
 */
export async function verifySessionToken(token: string, key: Uint8Array): Promise<SessionClaims> {
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: [ALGORITHM],
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
      requiredClaims: ['sub', 'jti', 'exp', 'iat', 'ten', 'spec', 'role'],
    });
    const { sub, jti, exp, ten, spec, role } = payload;
    if (
      typeof sub !== 'string' ||
      typeof jti !== 'string' ||
      typeof exp !== 'number' ||
      typeof ten !== 'string' ||
      typeof spec !== 'string' ||
      typeof role !== 'string'
    ) {
      throw new InvalidSessionToken('a claim has the wrong type');
    }
    return { jti, tenantId: ten, specId: spec, userId: sub, role, expiresAt: new Date(exp * 1000) };
  } catch (error) {
    if (error instanceof InvalidSessionToken) throw error;
    // Every jose failure (bad signature, expired, wrong audience or algorithm, malformed) ends
    // here, so a caller can never learn which check a forged token failed.
    const reason = error instanceof errors.JOSEError ? error.code : 'malformed';
    throw new InvalidSessionToken(reason);
  }
}

/** True when a bearer value looks like a JWT (three dot-separated parts), not an API key. */
export function looksLikeJwt(token: string): boolean {
  return token.split('.').length === 3;
}
