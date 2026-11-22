import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';

import {
  Body,
  Controller,
  Get,
  Injectable,
  Logger,
  type OnModuleInit,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { IsString, Length } from 'class-validator';

import { ApiKeyVerifier } from '../auth/api-key-verifier.js';
import { Public } from '../auth/auth.decorators.js';
import { SessionsService } from '../sessions/sessions.service.js';

/** POST /dev/login: what the form sends. */
export class DevLoginDto {
  @IsString()
  @Length(1, 200)
  apiKey!: string;

  @IsString()
  specId!: string;

  @IsString()
  @Length(1, 200)
  userId!: string;

  @IsString()
  @Length(1, 100)
  role!: string;
}

/**
 * DEV-ONLY sign-in (Step 4.4b, ADR 0029): mints a session token for a chosen host user and role,
 * so the console (and you, with curl) can act as a host user without a host app.
 *
 * It is the one place where a tenant API key is typed into a browser, which is why it EXISTS only
 * when PLATFORM_ENV=development: AppModule does not even register this controller otherwise, so
 * the routes are a plain 404 (a required test). It mints through SessionsService, so the same
 * rule applies: only a role of the spec's policy.
 */
@Controller('dev/login')
@Public()
export class DevLoginController {
  constructor(
    private readonly keys: ApiKeyVerifier,
    private readonly sessions: SessionsService,
  ) {}

  /** The login page. Inline script allowed only with this response's nonce (CSP). */
  @Get()
  page(@Res() res: ServerResponse): void {
    const nonce = randomBytes(16).toString('base64');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    res.end(loginPage(nonce));
  }

  /** Checks the key, then mints exactly as POST /sessions does. 401 for a bad key. */
  @Post()
  async login(@Body() dto: DevLoginDto) {
    const caller = await this.keys.verify(dto.apiKey);
    if (!caller)
      throw new UnauthorizedException('Missing, invalid, expired or revoked credentials.');
    return this.sessions.mint(caller.tenantId, caller.keyId, {
      specId: dto.specId,
      userId: dto.userId,
      role: dto.role,
    });
  }
}

/** Says loudly at startup that the dev login is on. */
@Injectable()
export class DevLoginNotice implements OnModuleInit {
  onModuleInit(): void {
    new Logger('DevLogin').warn(
      'PLATFORM_ENV=development: the dev login page is ON at /dev/login. Never run like this on a shared server.',
    );
  }
}

/** A small self-contained page: no external scripts, styles or fonts. */
function loginPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ToolBridge dev login</title>
<style nonce="${nonce}">
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 36rem; margin: 2rem auto; padding: 0 1rem; background: #fafafa; color: #1a1a1a; }
  .warn { background: #fff3cd; border: 1px solid #e0c36a; padding: .75rem 1rem; border-radius: 6px; }
  label { display: block; margin-top: .9rem; font-weight: 600; }
  input { width: 100%; box-sizing: border-box; padding: .5rem; font: inherit; }
  button { margin-top: 1.2rem; padding: .55rem 1.2rem; font: inherit; }
  pre { white-space: pre-wrap; word-break: break-all; background: #fff; border: 1px solid #ddd; padding: .75rem; border-radius: 6px; }
</style>
</head>
<body>
<h1>ToolBridge dev login</h1>
<p class="warn">Development only. This page takes a tenant API key in the browser, so it does not exist outside <code>PLATFORM_ENV=development</code>.</p>
<form id="f">
  <label>Tenant API key <input name="apiKey" type="password" autocomplete="off" required></label>
  <label>Spec id <input name="specId" required></label>
  <label>Host user id <input name="userId" value="dev-user" required></label>
  <label>Role (from the spec's policy) <input name="role" value="support" required></label>
  <button>Get a session token</button>
</form>
<h2>Result</h2>
<pre id="out">No token yet.</pre>
<script nonce="${nonce}">
  document.getElementById('f').addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.target));
    const res = await fetch('/dev/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json();
    document.getElementById('out').textContent = res.ok
      ? 'Authorization: Bearer ' + json.token + '\\n\\nExpires: ' + json.expiresAt
      : res.status + ': ' + (json.message ?? 'refused');
  });
</script>
</body>
</html>`;
}
