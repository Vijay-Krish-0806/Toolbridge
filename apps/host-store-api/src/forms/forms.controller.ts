import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthUser } from '../auth/auth.decorators.js';
import { Endpoint } from '../common/endpoint.decorator.js';
import { FormDto } from './forms.dto.js';
import { FormsService } from './forms.service.js';

@ApiTags('forms')
@Controller('forms')
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  @Get('order')
  @Endpoint({
    summary: 'Get the order form',
    description:
      'Describes the fields for POST /orders right now: types, limits, where to look up valid ' +
      'values, coupon codes usable at this moment, and fields only your role may use. Read it ' +
      'before creating an order; the options change as data changes.',
    ok: FormDto,
    roles: ['owner', 'support'],
  })
  orderForm(@CurrentUser() user: AuthUser): Promise<FormDto> {
    return this.forms.orderForm(user);
  }
}
