import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { HtmlTemplate } from './entities/html-template.entity';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

/**
 * Gestor de plantillas HTML (PROT-11.1).
 *
 * Exporta `TemplatesService` porque `TemplateMapperStrategy` (PROT-11.2) lo
 * inyecta para resolver la plantilla por `templateId` en tiempo de ejecucion.
 */
@Module({
  imports: [TypeOrmModule.forFeature([HtmlTemplate])],
  controllers: [TemplatesController],
  providers: [TemplatesService],
  exports: [TemplatesService],
})
export class TemplatesModule {}
