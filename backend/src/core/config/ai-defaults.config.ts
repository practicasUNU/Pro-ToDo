import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Defaults de IA declarados en el entorno, no en el codigo.
 *
 * Hasta ahora el proveedor y el modelo por omision eran constantes del DTO del
 * nodo (`DEFAULT_LLM_PROVIDER`, `DEFAULT_LLM_MODEL`), de modo que cambiarlos
 * exigia desplegar. Con el modo vision aparece ademas una segunda pregunta que
 * una sola constante no puede responder: el modelo bueno redactando no tiene por
 * que ser el bueno —ni el barato— leyendo un PDF escaneado, y ata las dos
 * decisiones quien las guarda en la misma variable.
 *
 * De ahi los DOS pares. `AI_DEFAULT_*` gobierna la inferencia de texto, que es
 * el 95% de las llamadas; `AI_OCR_DEFAULT_*` gobierna exclusivamente la lectura
 * de imagenes y PDFs escaneados, donde hoy manda Gemini por soportar
 * `inline_data` sobre la misma API REST que el backend ya sabe hablar.
 *
 * NO sustituye a los `params` del nodo: un nodo que declara su `provider` sigue
 * mandando sobre el entorno. Esto es el ultimo escalon antes de las constantes,
 * no el primero.
 */

/** Variables del par de texto. */
export const AI_DEFAULT_PROVIDER_VAR = 'AI_DEFAULT_PROVIDER';
export const AI_DEFAULT_MODEL_VAR = 'AI_DEFAULT_MODEL';

/** Variables del par de vision/OCR. */
export const AI_OCR_DEFAULT_PROVIDER_VAR = 'AI_OCR_DEFAULT_PROVIDER';
export const AI_OCR_DEFAULT_MODEL_VAR = 'AI_OCR_DEFAULT_MODEL';

/**
 * Traduccion de los valores del `.env` al enum `LlmProvider`.
 *
 * Hace falta una tabla explicita porque los dos vocabularios no coinciden: el
 * `.env` se escribe a mano y usa nombres comerciales en minuscula
 * (`google_gemini`), mientras que el enum es el contrato interno en mayusculas
 * (`GEMINI`). Un `toUpperCase()` acertaria con `anthropic` y fallaria justo con
 * el valor que mas se usa aqui.
 *
 * Se aceptan alias para los nombres que la gente escribe de mas de una forma:
 * `google_gemini` y `gemini` son el mismo proveedor, y rechazar el segundo seria
 * un rigor que solo produce incidencias de configuracion.
 *
 * El tipo de salida es `string` y no `LlmProvider` a proposito: este archivo
 * vive en `@core`, que no puede importar de `@modules`. Quien valida la cadena
 * contra el enum es la estrategia, que ya lo hace con `params.provider` a traves
 * de su DTO.
 */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  anthropic: 'ANTHROPIC',
  claude: 'ANTHROPIC',
  google_gemini: 'GEMINI',
  gemini: 'GEMINI',
  google: 'GEMINI',
  openai: 'OPENAI',
  chatgpt: 'OPENAI',
  mock: 'MOCK',
};

/** Un par proveedor/modelo resuelto, con `null` donde el entorno calla. */
export interface AiDefaultPair {
  /** Valor del enum `LlmProvider`, o `null` si no se declaro o no se reconoce. */
  readonly provider: string | null;
  readonly model: string | null;
}

@Injectable()
export class AiDefaultsConfig {
  private readonly logger = new Logger(AiDefaultsConfig.name);

  constructor(private readonly configService: ConfigService) {}

  /** Par por defecto para la inferencia de TEXTO. */
  public getTextDefaults(): AiDefaultPair {
    return {
      provider: this.resolveProvider(AI_DEFAULT_PROVIDER_VAR),
      model: this.readString(AI_DEFAULT_MODEL_VAR),
    };
  }

  /** Par por defecto para la lectura de IMAGENES y PDFs escaneados. */
  public getOcrDefaults(): AiDefaultPair {
    return {
      provider: this.resolveProvider(AI_OCR_DEFAULT_PROVIDER_VAR),
      model: this.readString(AI_OCR_DEFAULT_MODEL_VAR),
    };
  }

  /**
   * Traduce el valor de una variable al nombre del enum, o `null`.
   *
   * Un valor desconocido AVISA y devuelve `null` en vez de lanzar. Reventar el
   * arranque por un default mal escrito seria desproporcionado: el sistema tiene
   * un escalon mas abajo —las constantes del DTO— y sigue siendo capaz de
   * ejecutar flujos. Lo que no puede es decidirlo en silencio, de ahi el aviso.
   */
  private resolveProvider(variable: string): string | null {
    const raw = this.readString(variable);

    if (raw === null) {
      return null;
    }

    const resolved = PROVIDER_ALIASES[raw.toLowerCase()];

    if (resolved === undefined) {
      this.logger.warn(
        `${variable}="${raw}" no corresponde a ningun proveedor conocido (${Object.keys(PROVIDER_ALIASES).join(', ')}). Se ignora y se usara el valor por defecto del nodo.`,
      );

      return null;
    }

    return resolved;
  }

  /** Lee una variable y normaliza la ausencia y la cadena vacia a `null`. */
  private readString(variable: string): string | null {
    const raw = this.configService.get<string>(variable)?.trim();

    return raw === undefined || raw.length === 0 ? null : raw;
  }
}
