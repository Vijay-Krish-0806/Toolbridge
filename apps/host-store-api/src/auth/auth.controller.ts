import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint } from '../common/endpoint.decorator.js';
import { CurrentUser, type AuthUser } from './auth.decorators.js';
import { LoginDto, StaffDto, TokenDto } from './auth.dto.js';
import { AuthService } from './auth.service.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  @Endpoint({
    summary: 'Log in as a staff member',
    description:
      'Exchanges a staff email and password for a JWT access token valid for one hour. ' +
      'Send the token as "Authorization: Bearer <token>" on every other call. ' +
      'Returns 401 when the email or password is wrong.',
    ok: TokenDto,
    public: true,
  })
  login(@Body() body: LoginDto): Promise<TokenDto> {
    return this.auth.login(body.email, body.password);
  }

  @Get('me')
  @Endpoint({
    summary: 'Get the signed-in staff member',
    description: 'Returns the profile and role of the staff member who owns the access token.',
    ok: StaffDto,
  })
  me(@CurrentUser() user: AuthUser): Promise<StaffDto> {
    return this.auth.me(user);
  }
}
