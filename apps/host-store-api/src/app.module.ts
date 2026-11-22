import { Module, type DynamicModule } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { TOKEN_TTL_SECONDS } from './auth/auth.service.js';
import { CoreModule } from './common/core.module.js';
import type { HostConfig } from './config.js';
import { CouponsModule } from './coupons/coupons.module.js';
import { CustomersModule } from './customers/customers.module.js';
import { FormsModule } from './forms/forms.module.js';
import { HealthController } from './health/health.controller.js';
import { IdempotencyModule } from './idempotency/idempotency.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { ProductsModule } from './products/products.module.js';
import { RefundsModule } from './refunds/refunds.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { ShipmentsModule } from './shipments/shipments.module.js';

@Module({})
export class AppModule {
  /** Built from an already-validated config, so nothing below reads process.env directly. */
  static register(config: HostConfig, options: { lazyDatabase?: boolean } = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.register(config),
        // autoIndex off: indexes are built by the seed at a known time, not on every app start.
        // lazyDatabase: build the app without connecting (used by the spec export, which needs
        // only routes and DTOs).
        MongooseModule.forRoot(config.MONGO_URI, {
          dbName: config.MONGO_DB,
          autoIndex: false,
          lazyConnection: options.lazyDatabase ?? false,
        }),
        JwtModule.register({
          global: true,
          secret: config.JWT_SECRET,
          signOptions: { expiresIn: TOKEN_TTL_SECONDS },
        }),
        AuditModule,
        AuthModule,
        IdempotencyModule,
        ProductsModule,
        InventoryModule,
        CustomersModule,
        OrdersModule,
        ShipmentsModule,
        RefundsModule,
        CouponsModule,
        ReportsModule,
        FormsModule,
      ],
      controllers: [HealthController],
    };
  }
}
