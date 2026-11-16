import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { ROLES, type Role } from '../domain/user.schema.js';

export class LoginDto {
  @ApiProperty({ description: 'Staff email address.', example: 'support@store.example' })
  @IsEmail()
  email!: string;

  @ApiProperty({ description: 'Staff password.', example: 'change-me-local-only' })
  @IsString()
  @MinLength(1)
  password!: string;
}

export class TokenDto {
  @ApiProperty({ description: 'JWT to send as "Authorization: Bearer <token>".' })
  accessToken!: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: string;

  @ApiProperty({ description: 'Seconds until the token expires.', example: 3600 })
  expiresIn!: number;

  @ApiProperty({ enum: ROLES, example: 'support' })
  role!: Role;
}

export class StaffDto {
  @ApiProperty({ example: '5c41b2400800000000000002' })
  _id!: string;

  @ApiProperty({ example: 'Sam Support' })
  name!: string;

  @ApiProperty({ example: 'support@store.example' })
  email!: string;

  @ApiProperty({ enum: ROLES, example: 'support' })
  role!: Role;
}
