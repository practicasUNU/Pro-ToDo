import { PartialType } from '@nestjs/mapped-types';

import { CreateAiPromptTemplateDto } from './create-ai-prompt-template.dto';

/**
 * Edicion parcial de un prompt.
 *
 * `PartialType` de `@nestjs/mapped-types` y no de `@nestjs/swagger`, igual que
 * el resto de los modulos: es el que usa `ValidationPipe` para heredar los
 * decoradores de `class-validator` marcandolos opcionales.
 *
 * HEREDA `code` PERO EL SERVICIO LO IGNORA. No se excluye del tipo porque
 * `OmitType` sobre `PartialType` complica la herencia de decoradores sin ganar
 * nada: `update()` no lee ese campo. El codigo es la clave de maquina que citan
 * los `params` de los nodos, y cambiarla romperia en silencio todos los flujos
 * que la referencian. Renombrar es trabajo de `name`.
 */
export class UpdateAiPromptTemplateDto extends PartialType(
  CreateAiPromptTemplateDto,
) {}
