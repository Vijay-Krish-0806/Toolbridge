import { Controller, Get } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
// Default import: mongoose is CommonJS, and Node's ESM loader cannot see ConnectionStates as a
// named export (Model, Schema and Types work because Node detects them).
import mongoose, { type Connection } from 'mongoose';
import { Clock } from '../common/clock.js';
import { Endpoint } from '../common/endpoint.decorator.js';

class HealthDto {
  @ApiProperty({ enum: ['ok', 'degraded'], example: 'ok' })
  status!: 'ok' | 'degraded';

  @ApiProperty({ enum: ['up', 'down'], example: 'up' })
  database!: 'up' | 'down';

  @ApiProperty({
    description: 'The API clock. Frozen to the seed date when HOST_CLOCK_NOW is set.',
    example: '2026-11-01T00:00:00.000Z',
  })
  now!: string;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly clock: Clock,
  ) {}

  @Get()
  @Endpoint({
    summary: 'Check that the API and database are up',
    description: 'Reports database connectivity and the current API clock time.',
    ok: HealthDto,
    public: true,
  })
  check(): HealthDto {
    const up = this.connection.readyState === mongoose.ConnectionStates.connected;
    return {
      status: up ? 'ok' : 'degraded',
      database: up ? 'up' : 'down',
      now: this.clock.now().toISOString(),
    };
  }
}
