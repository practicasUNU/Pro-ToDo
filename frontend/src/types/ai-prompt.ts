/**
 * Contratos del repositorio de prompts de IA (PROT-15.2).
 *
 * Replica de los DTOs que sirve `AiPromptsController`. El desdoble entre
 * `AiPrompt` y `AiPromptDetail` NO es cosmetico: el listado del backend omite
 * `promptText` a proposito —una tabla con decenas de filas no necesita
 * kilobytes de instruccion por fila—, asi que editar obliga a pedir el detalle
 * por id.
 *
 * `createdAt` y `updatedAt` son `string` y no `Date`: lo que llega por JSON es
 * una cadena ISO-8601, y tiparlas como `Date` seria una mentira que solo se
 * descubriria al llamar a un metodo que no existe.
 */
export interface AiPrompt {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

/** Prompt con su instruccion completa, tal como lo devuelve `GET /ai-prompts/:id`. */
export interface AiPromptDetail extends AiPrompt {
  promptText: string;
}

/**
 * Alta de prompt.
 *
 * Sin `createdById`: la autoria la toma el backend del JWT. Sin proveedor ni
 * modelo: un prompt es un activo de texto, y que modelo lo ejecuta lo decide la
 * configuracion del nodo.
 */
export interface CreateAiPromptPayload {
  name: string;
  description?: string;
  promptText: string;
}

/** Edicion parcial; todo opcional, como el `PartialType` del backend. */
export interface UpdateAiPromptPayload {
  name?: string;
  description?: string;
  promptText?: string;
  active?: boolean;
}
