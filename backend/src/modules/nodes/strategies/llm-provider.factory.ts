import { Injectable, Logger } from '@nestjs/common';

import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';
import { AnthropicLlmProvider } from '@modules/nodes/strategies/providers/anthropic-llm.provider';
import { GeminiLlmProvider } from '@modules/nodes/strategies/providers/gemini-llm.provider';
import { MockLlmProvider } from '@modules/nodes/strategies/providers/mock-llm.provider';

import type { ILlmProviderClient } from '@modules/nodes/strategies/interfaces/llm-provider.interface';

/**
 * Resolucion polimorfica de clientes de modelo de lenguaje.
 *
 * POR QUE EXISTE. Hasta PROT-21 el mapeo `LlmProvider` -> cliente vivia
 * duplicado en dos metodos privados `resolveProvider`, uno en
 * `LlmExtractorStrategy` y otro en `OcrProcessorStrategy`. Las dos copias YA
 * habian divergido: la de OCR nunca llego a conocer `ANTHROPIC`, de modo que un
 * nodo de OCR configurado con ese proveedor degradaba al simulador aunque el
 * cliente existiera desde PROT-20 — en silencio, porque la degradacion es
 * precisamente el comportamiento normal de un proveedor sin cliente. Dar de
 * alta el catalogo habria anadido una tercera copia.
 *
 * Es a los clientes de LLM lo que `NodeStrategyFactory` es a las estrategias,
 * con una diferencia deliberada: aqui los clientes se INYECTAN por constructor
 * en vez de inscribirse en un `onModuleInit`. Los tres son providers del mismo
 * modulo y no hay ninguna dependencia circular que esquivar, asi que un
 * registro diferido solo anadiria un estado mutable y una ventana de tiempo en
 * la que la factoria responde a medias.
 *
 * NO LANZA NUNCA. Un proveedor sin cliente devuelve el simulador con un aviso
 * en el log, que es el criterio fijado en PROT-16: `AI_DEFAULT_PROVIDER` puede
 * nombrar un proveedor que todavia no existe, y fallar habria pausado de golpe
 * todo flujo que no declarase el suyo. Lo que sostiene la auditoria es
 * `metadata.isMock`, que viaja en el namespace de la ejecucion.
 *
 * LA GUARDA DE `dryRun` NO ESTA AQUI, y es a proposito: "no gastes dinero en
 * esta ejecucion" es una decision del nodo sobre su propia configuracion, no
 * una propiedad del proveedor. Cada estrategia la aplica antes de preguntar.
 */
@Injectable()
export class LlmProviderFactory {
  private readonly logger = new Logger(LlmProviderFactory.name);

  /**
   * Indice de proveedor a cliente.
   *
   * Se construye en el constructor y se congela por tipo (`ReadonlyMap`): un
   * registro que cambia en caliente convertiria "que proveedores hay" en una
   * respuesta dependiente del momento en que se pregunte.
   */
  private readonly clients: ReadonlyMap<LlmProvider, ILlmProviderClient>;

  constructor(
    private readonly mockProvider: MockLlmProvider,
    geminiProvider: GeminiLlmProvider,
    anthropicProvider: AnthropicLlmProvider,
  ) {
    this.clients = new Map<LlmProvider, ILlmProviderClient>([
      [LlmProvider.MOCK, mockProvider],
      [LlmProvider.GEMINI, geminiProvider],
      [LlmProvider.ANTHROPIC, anthropicProvider],
      // OPENAI no esta: el enum lo declara para que el DTO no cambie cuando
      // llegue, pero sin cliente se resuelve al simulador por la via de abajo.
    ]);
  }

  /**
   * Devuelve el cliente de un proveedor. SIEMPRE devuelve uno.
   *
   * @param provider Proveedor declarado en los `params` del nodo.
   * @returns El cliente del proveedor, o el simulador si todavia no tiene uno.
   */
  public getClient(provider: LlmProvider): ILlmProviderClient {
    const client = this.clients.get(provider);

    if (client !== undefined) {
      return client;
    }

    this.logger.warn(
      `El proveedor "${provider}" todavia no tiene cliente implementado. Se degrada a simulacion de coste cero; la salida llevara isMock: true.`,
    );

    return this.mockProvider;
  }

  /**
   * Responde si un proveedor tiene cliente propio, SIN degradar ni avisar.
   *
   * Lo consulta el catalogo de modelos, que necesita distinguir "existe el
   * cliente" de "lo que te devolveria `getClient`". Preguntarlo con
   * `getClient` habria llenado el log de avisos cada vez que alguien abre el
   * asistente, que es justo cuando no ha pasado nada raro.
   */
  public hasClient(provider: LlmProvider): boolean {
    return this.clients.has(provider);
  }

  /** Proveedores con cliente, para diagnostico y pruebas. */
  public getImplementedProviders(): ReadonlySet<LlmProvider> {
    return new Set(this.clients.keys());
  }
}
