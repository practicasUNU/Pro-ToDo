import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { promptReferenceKey } from '@core/fsm/types/prompt-text-resolver.port';

import { AiPromptTemplate } from './entities/ai-prompt-template.entity';

import type {
  PromptReference,
  PromptTextResolverPort,
} from '@core/fsm/types/prompt-text-resolver.port';

/**
 * Forma de un UUID, para no mandar a PostgreSQL algo que no pueda comparar.
 *
 * `templatePromptId` ya pasa por `@IsUUID('4')` en el DTO del nodo, y la
 * validacion de params corre ANTES que la de topologia, asi que en la practica
 * aqui nunca llega basura. Se filtra igualmente porque el coste es nulo y la
 * alternativa es un error de tipo de PostgreSQL —no un 400 legible— si algun dia
 * el orden de las validaciones cambia.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Implementacion del puerto que `@core` declara para leer prompts guardados.
 *
 * Vive en este modulo y no en el nucleo porque es quien conoce la tabla. El
 * validador de topologia solo ve la interfaz, de modo que la dependencia apunta
 * hacia dentro: `@core` no importa nada de `@modules`.
 *
 * NO REUTILIZA `AiPromptTemplatesService`, y es deliberado. Sus buscadores
 * lanzan `NotFoundException` y resuelven de uno en uno; aqui hace falta lo
 * contrario: una sola consulta para todo el esquema, y silencio ante lo que no
 * existe. Consultar el repositorio directamente es mas corto que envolver cuatro
 * llamadas en `try/catch`, y mantiene la promesa de "una consulta por
 * validacion" que el puerto documenta.
 */
@Injectable()
export class AiPromptTextResolverAdapter implements PromptTextResolverPort {
  constructor(
    @InjectRepository(AiPromptTemplate)
    private readonly promptRepository: Repository<AiPromptTemplate>,
  ) {}

  public async resolvePromptTexts(
    references: readonly PromptReference[],
  ): Promise<ReadonlyMap<string, string>> {
    // Guarda: sin referencias no hay consulta que hacer. Es el caso normal de
    // cualquier flujo que no use un prompt guardado.
    if (references.length === 0) return new Map();

    const ids = [
      ...new Set(
        references
          .filter(({ kind }) => kind === 'id')
          .map(({ value }) => value)
          .filter((value) => UUID_PATTERN.test(value)),
      ),
    ];

    const codes = [
      ...new Set(
        references
          .filter(({ kind }) => kind === 'code')
          .map(({ value }) => value),
      ),
    ];

    if (ids.length === 0 && codes.length === 0) return new Map();

    // Un arreglo de condiciones es un OR en TypeORM: id IN (...) OR codigo IN (...).
    // Las plantillas DESACTIVADAS entran a proposito: lo que se comprueba aqui es
    // de que namespaces depende el flujo, y eso no cambia porque alguien retire
    // el prompt del selector. De la plantilla retirada se queja la ejecucion.
    const prompts = await this.promptRepository.find({
      where: [
        ...(ids.length > 0 ? [{ id: In(ids) }] : []),
        ...(codes.length > 0 ? [{ code: In(codes) }] : []),
      ],
    });

    const texts = new Map<string, string>();

    // Se indexa por las DOS claves posibles y no por la referencia recibida: la
    // misma fila puede citarse por id en un nodo y por codigo en otro, y asi la
    // consulta unica sirve a ambos.
    for (const prompt of prompts) {
      texts.set(promptReferenceKey({ kind: 'id', value: prompt.id }), prompt.promptText);
      texts.set(
        promptReferenceKey({ kind: 'code', value: prompt.code }),
        prompt.promptText,
      );
    }

    return texts;
  }
}
