/**
 * Precedencia entre lo que guarda un nodo y lo que declara el entorno.
 *
 * El escalon normal es `params del nodo > entorno > constante`, y para la
 * mayoria de los campos basta. Deja de bastar en los valores de
 * INFRAESTRUCTURA —la espera de red y los reintentos—, porque el asistente los
 * publica SIEMPRE en el `pipeline_schema` aunque el operador no los haya
 * tocado: un flujo guardado hace meses lleva `timeoutMs: 15000` clavado en su
 * JSONB y gana a un `.env` que pide 60 000, de modo que la variable no sirve
 * para nada alli donde mas falta hace.
 *
 * Estas dos funciones invierten esa precedencia SOLO cuando el entorno habla.
 * Son puras: ni estado, ni E/S, ni dependencia de Nest.
 */

/**
 * Piso de infraestructura: el entorno manda cuando pide MAS que lo guardado.
 *
 * Con `envValue === null` no hay piso y se conserva la precedencia normal. Esa
 * guarda es lo que hace que una instalacion que no declare la variable no
 * cambie de conducta: sin ella habria que usar la constante por defecto como
 * piso, y entonces un flujo que eligio a proposito una espera corta —1 000 ms
 * es legal hoy— subiria en silencio al defecto sin que nadie hubiera tocado el
 * `.env`.
 *
 * Cuando el entorno SI habla, un `dtoValue` ausente se resuelve contra el
 * propio `envValue` y no contra `fallback`, de modo que el `Math.max` no puede
 * devolver menos que el entorno. El `fallback` solo entra en juego en la otra
 * rama.
 */
export const applyEnvironmentFloor = (
  dtoValue: number | undefined,
  envValue: number | null,
  fallback: number,
): number =>
  envValue === null
    ? (dtoValue ?? fallback)
    : Math.max(dtoValue ?? envValue, envValue);

/**
 * Techo de infraestructura: el entorno manda cuando pide MENOS que lo guardado.
 *
 * La asimetria con el piso es deliberada y responde a de que lado esta el
 * riesgo en cada campo. En la ESPERA, quedarse corto significa matar una
 * inferencia que iba bien, asi que el entorno sube. En los REINTENTOS, pasarse
 * significa pagar: se multiplican por la cadena de respaldo de proveedores y
 * cada vuelta factura tokens, asi que el entorno baja.
 *
 * Usar el piso para los dos dejaria al administrador sin forma de contener un
 * flujo que guardo cinco reintentos; usar el techo para los dos reproduciria
 * exactamente el fallo que esto viene a arreglar.
 */
export const applyEnvironmentCeiling = (
  dtoValue: number | undefined,
  envValue: number | null,
  fallback: number,
): number =>
  envValue === null
    ? (dtoValue ?? fallback)
    : Math.min(dtoValue ?? envValue, envValue);
