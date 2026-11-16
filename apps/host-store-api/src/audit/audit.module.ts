import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MODEL } from '../domain/models.js';
import { AuditService } from './audit.service.js';

/** Global: every feature that writes data records an audit event. */
@Global()
@Module({
  imports: [MongooseModule.forFeature([MODEL.AuditEvent])],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
