import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type QueryFilter, type Types } from 'mongoose';
import { containsText, paginate, type Page } from '../common/query.js';
import type { Customer } from '../domain/customer.schema.js';
import { MODEL } from '../domain/models.js';
import type { ListCustomersQuery } from './customers.dto.js';

@Injectable()
export class CustomersService {
  constructor(@InjectModel(MODEL.Customer.name) private readonly customers: Model<Customer>) {}

  list(query: ListCustomersQuery): Promise<Page<Customer>> {
    const filter: QueryFilter<Customer> = {};
    if (query.tier) filter.tier = query.tier;
    if (query.country) filter['address.country'] = query.country.toUpperCase();
    if (query.search) {
      const text = containsText(query.search);
      filter.$or = [{ name: text }, { email: text }];
    }
    return paginate(this.customers, filter, { name: 1, _id: 1 }, query);
  }

  async getById(id: Types.ObjectId): Promise<Customer> {
    const customer = await this.customers.findById(id).lean().exec();
    if (!customer) throw new NotFoundException(`No customer with id ${id.toHexString()}.`);
    return customer;
  }
}
