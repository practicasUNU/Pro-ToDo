import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { HtmlTemplate } from './entities/html-template.entity';
import { TemplateRendererService } from './services/template-renderer.service';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

/**
 * Gestor de plantillas HTML (PROT-11.1).
 *
 * Exporta ambos servicios porque `TemplateMapperStrategy` (PROT-11.2) inyecta
 * los dos: `TemplatesService` para resolver la plantilla por `templateId` y
 * `TemplateRendererService` para compilarla. Ese reparto es lo que garantiza que
 * la vista previa del gestor y el render del nodo usen el MISMO motor.
 */
@Module({
  imports: [TypeOrmModule.forFeature([HtmlTemplate])],
  controllers: [TemplatesController],
  providers: [TemplatesService, TemplateRendererService],
  exports: [TemplatesService, TemplateRendererService],
})
export class TemplatesModule {}
