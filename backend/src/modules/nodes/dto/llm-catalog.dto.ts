import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';

import { LlmProvider } from '@modules/nodes/strategies/interfaces/llm-provider.interface';

import type { NodeErrorSeverity } from '@core/fsm/types/node-strategy.types';

/**
 * Longitud maxima del identificador de modelo aceptado en la prueba.
 *
 * Replica el limite de hecho del campo `model` del nodo. No hay columna que
 * copiar —el modelo vive dentro del `jsonb` del `pipeline_schema`—, asi que el
 * numero acota el abuso, no un esquema: nadie necesita 120 caracteres para
 * nombrar un modelo, y sin tope el campo acepta un documento entero.
 */
export const MAX_LLM_MODEL_LENGTH = 120;

/** Caracteres de la respuesta del modelo que se devuelven como muestra. */
export const LLM_PREVIEW_LENGTH = 200;

/**
 * Un modelo concreto de un proveedor, tal y como lo ve el asistente.
 *
 * POR QUE UNA TABLA CURADA Y NO LA API DE CADA PROVEEDOR. `label`,
 * `supportsVision` y `contextWindow` no se pueden pedir de forma uniforme: los
 * listados de modelos de Anthropic y de Google devuelven formas distintas, y
 * ninguno expone una etiqueta pensada para un selector. Consultarlos ademas
 * meteria dos llamadas de red en el momento de abrir el asistente, que es
 * cuando menos se puede permitir esperar. Lo que SI se calcula en cada
 * peticion es `isAvailable`, que es justo lo que cambia sin desplegar.
 */
export class LlmModelDescriptor {
  @ApiProperty({
    description: 'Proveedor que ejecuta el modelo',
    enum: LlmProvider,
    example: LlmProvider.ANTHROPIC,
  })
  provider: LlmProvider;

  @ApiProperty({
    description:
      'Identificador tecnico, tal y como viaja en los params del nodo',
    example: 'claude-sonnet-5-5',
  })
  model: string;

  @ApiProperty({
    description: 'Nombre legible para el selector del asistente',
    example: 'Claude Sonnet 5.5',
  })
  label: string;

  @ApiProperty({
    description:
      'true si el proveedor tiene cliente implementado Y su credencial esta presente en el entorno. ' +
      'Se recalcula en cada peticion: es lo unico que puede cambiar sin desplegar.',
    example: true,
  })
  isAvailable: boolean;

  @ApiProperty({
    description:
      'true para el simulador y cualquier entorno de pruebas: responde sin salir a ningun proveedor y sin coste',
    example: false,
  })
  isTestOnly: boolean;

  @ApiProperty({
    description:
      'true si acepta imagenes o PDF escaneados. Lo necesita la ruta de recuperacion por vision del parser',
    example: true,
  })
  supportsVision: boolean;

  @ApiProperty({
    description: 'Ventana de contexto del modelo, en tokens',
    example: 1_000_000,
  })
  contextWindow: number;
}

/**
 * Peticion de prueba de conectividad.
 *
 * NO ADMITE UN PROMPT. La prueba verifica dos cosas —que la credencial sirve y
 * que el proveedor responde— y para eso basta un ping constante que fija el
 * backend. Dejar el texto al cliente pondria el coste facturable de cada
 * pulsacion en manos de quien llame al endpoint, que es exactamente lo que un
 * boton de "probar" no debe permitir.
 */
export class LlmTestConnectionDto {
  @ApiProperty({
    description: 'Proveedor contra el que se prueba',
    enum: LlmProvider,
    example: LlmProvider.ANTHROPIC,
  })
  @IsEnum(LlmProvider, {
    message: `provider debe ser uno de: ${Object.values(LlmProvider).join(', ')}.`,
  })
  readonly provider: LlmProvider;

  @ApiProperty({
    description: 'Identificador del modelo a probar',
    example: 'claude-sonnet-5-5',
    maxLength: MAX_LLM_MODEL_LENGTH,
  })
  @IsString({ message: 'model debe ser una cadena.' })
  @IsNotEmpty({ message: 'model no puede estar vacio.' })
  @MaxLength(MAX_LLM_MODEL_LENGTH, {
    message: `model no puede superar ${MAX_LLM_MODEL_LENGTH} caracteres.`,
  })
  readonly model: string;
}

/** Detalle del fallo, con la escala de severidad del motor FSM. */
export class LlmTestConnectionErrorDto {
  @ApiProperty({
    description:
      'Severidad del fallo, con la misma escala que `NodeResult.error.level`',
    example: 'GRAVE',
    enum: ['LEVE', 'GRAVE', 'URGENTE'],
  })
  level: NodeErrorSeverity;

  @ApiProperty({
    description: 'Motivo legible del fallo',
    example:
      'ERR_HTTP_CLIENT_REJECTED: El servicio remoto rechazo la peticion con 401',
  })
  message: string;
}

/**
 * Resultado de la prueba de conectividad.
 *
 * Igual que las comprobaciones del asistente, un fallo de conexion es un 200
 * con `success: false` y nunca una excepcion: el 4xx queda reservado a un
 * cuerpo mal formado.
 *
 * `isMock` NO estaba en la peticion original y es la pieza que hace util al
 * resto. Un proveedor sin su clave de API no falla: degrada al simulador y
 * responde correctamente. Sin este campo, esa respuesta seria indistinguible
 * de una inferencia real, y el boton diria "conexion correcta" precisamente en
 * el caso que viene a detectar.
 */
export class LlmTestConnectionResponseDto {
  @ApiProperty({
    description: 'true si el proveedor respondio algo utilizable',
    example: true,
  })
  success: boolean;

  @ApiProperty({
    description:
      'Tiempo transcurrido de extremo a extremo, en milisegundos. Incluye la red, no solo la inferencia',
    example: 842,
  })
  latencyMs: number;

  @ApiProperty({
    description:
      'true si respondio el simulador. Ocurre al elegir MOCK y tambien cuando falta la credencial del proveedor real',
    example: false,
  })
  isMock: boolean;

  @ApiProperty({
    description: `Primeros ${LLM_PREVIEW_LENGTH} caracteres de lo que redacto el modelo. Vacio si fallo`,
    example: 'Conexion verificada con el proveedor.',
  })
  outputPreview: string;

  @ApiPropertyOptional({
    description: 'Detalle del fallo. Presente solo cuando `success` es false',
    type: LlmTestConnectionErrorDto,
  })
  error?: LlmTestConnectionErrorDto;
}
