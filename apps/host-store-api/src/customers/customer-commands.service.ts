import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, type Connection, type Types } from 'mongoose';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.decorators.js';
import type { Customer } from '../domain/customer.schema.js';
import { MODEL } from '../domain/models.js';
import type { UpdateCustomerDto } from './customers.dto.js';

@Injectable()
export class CustomerCommandsService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(MODEL.Customer.name) private readonly customers: Model<Customer>,
    private readonly audit: AuditService,
  ) {}

  update(id: Types.ObjectId, dto: UpdateCustomerDto, actor: AuthUser): Promise<Customer> {
    const changes: Partial<Customer> = {};
    if (dto.phone !== undefined) changes.phone = dto.phone;
    if (dto.notes !== undefined) changes.notes = dto.notes;
    if (dto.address) {
      const { line1, city, postalCode, country } = dto.address;
      changes.address = { line1, city, postalCode, country: country.toUpperCase() };
    }
    if (Object.keys(changes).length === 0) {
      throw new BadRequestException('Send at least one field to change.');
    }
    return this.connection.transaction(async (session) => {
      const customer = await this.customers
        .findByIdAndUpdate(id, { $set: changes }, { session, returnDocument: 'after' })
        .lean()
        .exec();
      if (!customer) throw new NotFoundException(`Customer ${id.toHexString()} does not exist.`);
      await this.audit.record(
        actor,
        {
          action: 'customer.update',
          targetType: 'customer',
          targetId: id.toHexString(),
          details: { fields: Object.keys(changes) },
        },
        session,
      );
      return customer;
    });
  }
}
