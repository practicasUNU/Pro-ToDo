import { PartialType } from '@nestjs/mapped-types';

import { CreateAiPromptDto } from './create-ai-prompt.dto';

/**
 * Edicion parcial de un prompt.
 *
 * `PartialType` de `@nestjs/mapped-types` y no de `@nestjs/swagger`, igual que
 * el resto de los modulos: es el que usa `ValidationPipe` para heredar los
 * decoradores de `class-validator` marcandolos opcionales.
 */
export class UpdateAiPromptDto extends PartialType(CreateAiPromptDto) {}
