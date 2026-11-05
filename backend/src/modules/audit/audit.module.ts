import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditController } from '@modules/audit/audit.controller';
import { AuditEvento } from '@modules/audit/entities/audit-evento.entity';
import { AuditInterceptor } from '@modules/audit/interceptors/audit.interceptor';
import { AuditPdfRenderer } from '@modules/audit/reports/audit-pdf.renderer';
import { AuditLoggerService } from '@modules/audit/services/audit-logger.service';
import { AuditSnapshotService } from '@modules/audit/services/audit-snapshot.service';
import { BrowserModule } from '@modules/nodes/browser.module';

/**
 * Auditoria de acciones humanas (migracion 048).
 *
 * Hoja del grafo de modulos: solo importa su repositorio y `BrowserModule`.
 * Las fotografias de las maestras se leen por `DataSource` y los controladores
 * auditados solo importan el decorador, asi que ningun modulo de negocio
 * necesita importar este (salvo `AuthModule`, para registrar los logins).
 *
 * El interceptor es GLOBAL (`APP_INTERCEPTOR`) pero inerte: solo actua sobre
 * los handlers marcados con `@AuditAction`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AuditEvento]), BrowserModule],
  controllers: [AuditController],
  providers: [
    AuditLoggerService,
    AuditSnapshotService,
    AuditPdfRenderer,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditLoggerService],
})
export class AuditModule {}
