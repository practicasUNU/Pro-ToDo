import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PROMPT_TEXT_RESOLVER } from '@core/fsm/types/prompt-text-resolver.port';

import { AiPromptTextResolverAdapter } from './ai-prompt-text-resolver.adapter';
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
 *
 * Exporta ademas `PROMPT_TEXT_RESOLVER`, la implementacion del puerto que
 * `@core` declara para poder analizar los namespaces que cita un prompt al
 * VALIDAR un flujo. El token se provee aqui —no en `@core`— precisamente para
 * que el nucleo siga sin conocer esta tabla: solo ve la interfaz.
 *
 * Sigue sin importar ningun otro modulo: el puerto es un tipo, no un servicio.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AiPromptTemplate])],
  controllers: [AiPromptTemplatesController],
  providers: [
    AiPromptTemplatesService,
    { provide: PROMPT_TEXT_RESOLVER, useClass: AiPromptTextResolverAdapter },
  ],
  exports: [AiPromptTemplatesService, PROMPT_TEXT_RESOLVER],
})
export class AiPromptTemplatesModule {}
