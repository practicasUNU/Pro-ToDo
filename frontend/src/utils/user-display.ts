// Helper puro de presentacion (ver frontend-architecture.md §2.1): sin estado
// ni I/O. La entidad `usuarios` del backend no persiste un nombre propio, asi
// que el nombre a mostrar se deriva de la parte local del correo corporativo.

const SEPARATOR_PATTERN = /[._-]+/;

// Umbral minimo del apellido al partir un local-part sin separador. Evita el
// falso positivo "admin" -> "A. Dmin": con 4 caracteres restantes no se parte.
const MIN_SURNAME_LENGTH = 5;

const EMPTY_DISPLAY_NAME = '—';

const capitalize = (segment: string): string =>
  segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase();

/**
 * Deriva un nombre legible a partir de un correo corporativo.
 *
 * - Con separador: capitaliza cada segmento; uno de un solo caracter se rinde
 *   como inicial con punto (`v.garcia` -> `V. Garcia`, `victor.garcia` -> `Victor Garcia`).
 * - Sin separador y con apellido suficientemente largo: inicial + apellido
 *   (`mmolina` -> `M. Molina`).
 * - Cualquier otro caso: capitalizacion simple (`admin` -> `Admin`).
 * - Correo vacio o sin parte local: guion largo.
 */
export const deriveDisplayName = (email: string): string => {
  const localPart = email?.split('@')[0]?.trim() ?? '';
  if (!localPart) return EMPTY_DISPLAY_NAME;

  const segments = localPart.split(SEPARATOR_PATTERN).filter(Boolean);
  if (segments.length === 0) return EMPTY_DISPLAY_NAME;

  if (segments.length > 1) {
    return segments
      .map((segment) => (segment.length === 1 ? `${segment.toUpperCase()}.` : capitalize(segment)))
      .join(' ');
  }

  const [single] = segments as [string];

  if (single.length - 1 >= MIN_SURNAME_LENGTH) {
    return `${single.charAt(0).toUpperCase()}. ${capitalize(single.slice(1))}`;
  }

  return capitalize(single);
};
