import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AiPromptTemplatesController } from './ai-prompt-templates.controller';
import { AiPromptTemplatesService } from './ai-prompt-templates.service';
import { AiPromptTemplate } from './entities/ai-prompt-template.entity';

/**
 * Repositorio de prompts de IA (PROT-15.2).
 *
 * No importa ningun otro modulo: un prompt es texto y no depende del motor, del
 * catalogo de nodos ni de las plantillas. Ese aislamiento es el objetivo de la
 * subtarea, no una casualidad.
 *
 * Exporta el servicio porque PROT-15.3 lo inyectara desde la estrategia del
 * nodo `PROCESADOR_IA`, que resolvera el prompt por nombre o por id.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AiPromptTemplate])],
  controllers: [AiPromptTemplatesController],
  providers: [AiPromptTemplatesService],
  exports: [AiPromptTemplatesService],
})
export class AiPromptTemplatesModule {}
