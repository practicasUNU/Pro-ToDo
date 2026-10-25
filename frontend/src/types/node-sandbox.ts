import { NodeType } from '@/types/pipeline';
import { UserRole } from '@/types/user';

/**
 * Tipos de nodo que el banco de pruebas puede EJECUTAR aislados, y quien.
 *
 * Replica de `SANDBOX_ROLES_BY_NODE_TYPE` del backend, que es la autoridad: aqui
 * solo sirve para no ofrecer un boton que devolveria un 403. IA y OCR facturan
 * cada prueba, por eso son solo de ADMIN.
 */
export const SANDBOX_ROLES_BY_NODE_TYPE: Readonly<Partial<Record<NodeType, readonly UserRole[]>>> =
  {
    [NodeType.PROCESADOR_IA]: [UserRole.ADMIN],
    [NodeType.PROCESADOR_OCR]: [UserRole.ADMIN],
    [NodeType.DESTINO_HTTP_GENERICO]: [UserRole.ADMIN, UserRole.EDITOR],
  };

/** Tipos cuya prueba cuesta dinero: piden confirmacion antes de lanzarse. */
export const BILLABLE_SANDBOX_NODE_TYPES: ReadonlySet<NodeType> = new Set([
  NodeType.PROCESADOR_IA,
  NodeType.PROCESADOR_OCR,
]);

/** Tope del adjunto de una prueba de OCR (el backend admite 10 MB de cuerpo). */
export const MAX_SANDBOX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Replica de `RunNodeSandboxDto`. */
export interface RunNodeSandboxPayload {
  readonly nodeType: NodeType;
  readonly params: Record<string, unknown>;
  readonly upstreamContext: Record<string, Record<string, unknown>>;
}

/** Replica de `NodeSandboxErrorDto`: sin traza de pila, nunca sale del servidor. */
export interface NodeSandboxError {
  readonly level: 'LEVE' | 'GRAVE' | 'URGENTE';
  readonly code: string;
  readonly message: string;
  readonly description?: string;
  readonly missingFields?: string[];
}

/** Replica de `NodeSandboxResultDto`. */
export interface NodeSandboxResult {
  readonly success: boolean;
  readonly data?: Record<string, unknown>;
  readonly error?: NodeSandboxError;
  readonly durationMs: number;
}

/** Adjunto de una prueba de OCR, con la forma que lee la estrategia. */
export interface SandboxAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly contentBase64: string;
}
