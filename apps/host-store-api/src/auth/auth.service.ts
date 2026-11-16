import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MODEL } from '../domain/models.js';
import type { User } from '../domain/user.schema.js';
import type { AuthUser, JwtPayload } from './auth.decorators.js';
import type { StaffDto, TokenDto } from './auth.dto.js';
import { verifyPassword } from './password.js';

export const TOKEN_TTL_SECONDS = 3600;

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(MODEL.User.name) private readonly users: Model<User>,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string): Promise<TokenDto> {
    const user = await this.users.findOne({ email: email.toLowerCase() }).lean().exec();
    // Same message for "no such user" and "wrong password", so callers cannot probe for emails.
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedException('Invalid email or password.');
    }
    const payload: JwtPayload = { sub: user._id.toHexString(), email: user.email, role: user.role };
    return {
      accessToken: await this.jwt.signAsync(payload),
      tokenType: 'Bearer',
      expiresIn: TOKEN_TTL_SECONDS,
      role: user.role,
    };
  }

  async me(authUser: AuthUser): Promise<StaffDto> {
    const user = await this.users.findById(authUser.id, { passwordHash: 0 }).lean().exec();
    if (!user) throw new NotFoundException('This staff account no longer exists.');
    return { _id: user._id.toHexString(), name: user.name, email: user.email, role: user.role };
  }
}
