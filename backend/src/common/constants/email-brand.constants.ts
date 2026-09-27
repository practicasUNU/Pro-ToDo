/**
 * Paleta institucional para las cartas HTML que el sistema envia por correo.
 *
 * Es el UNICO rincon del proyecto exento de la regla de tokens CSS
 * (`frontend-quasar.md` §2): los `var(--pd-*)` no existen dentro de un cliente
 * de correo, que ademas descarta las hojas externas y el `<style>` del `<head>`.
 * La paleta se replica aqui como constantes y se inyecta EN LINEA en cada
 * etiqueta.
 *
 * Vive en un modulo propio y no dentro de un servicio porque ya son dos las
 * cartas que la usan —el codigo de acceso y la alerta de incidencia—, y dos
 * copias de `#2C4FC7` divergen a la primera revision de marca. Los valores son
 * los mismos que el modo CLARO de `app.scss`: un correo se lee sobre el fondo
 * que decida el cliente, asi que la carta no conmuta con el tema.
 */

/** `--pd-primary`: inicio del degradado de cabecera. */
export const BRAND_PRIMARY = '#2C4FC7';

/** `--pd-primary-light`: fin del degradado de cabecera. */
export const BRAND_PRIMARY_LIGHT = '#4E74E8';

/** `--pd-text-primary` (modo claro): titulares. */
export const BRAND_TEXT = '#12142E';

/** `--pd-text-secondary` (modo claro): parrafos y metadatos. */
export const BRAND_TEXT_MUTED = '#4A4F6B';

/** `--pd-card-bg` (modo claro): fondo de la pagina del correo. */
export const BRAND_SURFACE = '#EEF1FA';

/** `--pd-border` (modo claro): separadores y bordes de recuadro. */
export const BRAND_BORDER = '#D3D8EE';

/** `--pd-negative`: severidad URGENTE. */
export const BRAND_NEGATIVE = '#E74C3C';

/** `--pd-warning`: severidad GRAVE. */
export const BRAND_WARNING = '#F59E0B';

/** `--pd-page-bg` del modo oscuro: fondo del bloque de payload tecnico. */
export const BRAND_CODE_SURFACE = '#0D0F26';

/**
 * Pila tipografica del correo.
 *
 * NO son las familias del sistema de diseno (Poppins / Inter / JetBrains Mono):
 * enlazarlas exigiria una peticion a un CDN de fuentes desde el buzon de quien
 * lee, y el proyecto no hace peticiones a terceros. Se cae a las fuentes del
 * sistema operativo, que es lo que cualquier cliente de correo sabe pintar.
 */
export const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** Pila monoespaciada para el bloque de payload. Mismo criterio que la anterior. */
export const MONO_FONT_STACK =
  "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace";
