import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

// Opciones del selector determinista de URL: POSICIONES del contexto aguas
// arriba, nunca URLs concretas. Lo comparten el extractor web y el destino HTTP
// generico, que antes solo tenia el explorador de variables y obligaba a
// teclear la referencia (o a adivinar la sintaxis del indice).

/** Posiciones de un `url[]` que el selector ofrece una a una. */
export const SELECTABLE_URL_SLOTS = 10;

/**
 * Etiqueta de la opcion que delega la eleccion en el nodo.
 *
 * Solo la entiende el extractor web, que resuelve `{{ns.campo}}` sobre un
 * arreglo como "primer enlace no excluido". Cualquier otro nodo interpolaria el
 * arreglo entero, asi que el destino HTTP no la ofrece.
 */
export const FIRST_ELIGIBLE_LABEL_SUFFIX = 'primer enlace elegible';

/** Opcion del selector determinista de URL. */
export interface TargetUrlOption {
  readonly label: string;
  readonly value: string;
}

/** Plantilla de interpolacion de un campo escalar. */
export const urlTemplateFor = (namespace: string, field: string): string =>
  `{{${namespace}.${field}}}`;

/** Plantilla de interpolacion de la posicion `index` de un campo de arreglo. */
export const indexedUrlTemplateFor = (namespace: string, field: string, index: number): string =>
  `{{${namespace}.${field}[${index}]}}`;

export interface UrlOptionsSettings {
  /** Ofrecer `{{ns.campo}}` sobre un `url[]` como "primer enlace elegible". */
  readonly includeFirstEligible: boolean;
}

/**
 * Opciones a partir del contexto que declara el anfitrion.
 *
 * Solo los campos de tipo URL: un `character_count` es interpolable igual que
 * cualquier otro, pero ofrecerlo como origen de una direccion seria el error de
 * tipeo que el selector existe para impedir. Un `url[]` se despliega en
 * `SELECTABLE_URL_SLOTS` posiciones; un `url` escalar aporta una sola opcion.
 */
export const buildUrlOptions = (
  context: readonly UpstreamNamespace[],
  { includeFirstEligible }: UrlOptionsSettings,
): readonly TargetUrlOption[] =>
  context.flatMap(({ namespace, fields }) =>
    fields.flatMap((field) => {
      const suffix = field.description === undefined ? '' : ` — ${field.description}`;

      if (field.type === 'url') {
        return [
          {
            label: `${namespace}.${field.name}${suffix}`,
            value: urlTemplateFor(namespace, field.name),
          },
        ];
      }

      if (field.type !== 'url[]') return [];

      const slots = Array.from({ length: SELECTABLE_URL_SLOTS }, (_, index) => ({
        label: `${namespace}.${field.name} — posicion ${index + 1}`,
        value: indexedUrlTemplateFor(namespace, field.name, index),
      }));

      // LA PRIMERA opcion del arreglo no es una posicion: es un CRITERIO. El
      // enlace del portal propio y el de la noticia llegan en el mismo correo y
      // su orden cambia de un dia para otro, asi que fijar la posicion 1 raspa
      // tan pronto uno como el otro. Delegando en el nodo, la eleccion la hace
      // "no ser un dominio excluido", que si es estable.
      return includeFirstEligible
        ? [
            {
              label: `${namespace}.${field.name} — ${FIRST_ELIGIBLE_LABEL_SUFFIX} (salta los dominios excluidos)`,
              value: urlTemplateFor(namespace, field.name),
            },
            ...slots,
          ]
        : slots;
    }),
  );

/**
 * Inserta `token` en `text` sustituyendo la seleccion `[start, end)`.
 *
 * Sin posicion conocida (el campo nunca tuvo el foco) se anade al final, que
 * era el comportamiento anterior. Devuelve tambien el cursor resultante para
 * que el anfitrion lo deje detras de lo insertado.
 */
export const insertAtCaret = (
  text: string,
  token: string,
  start: number | null,
  end: number | null,
): { readonly text: string; readonly caret: number } => {
  const from = start === null ? text.length : Math.min(Math.max(start, 0), text.length);
  const to = end === null ? from : Math.min(Math.max(end, from), text.length);

  return { text: `${text.slice(0, from)}${token}${text.slice(to)}`, caret: from + token.length };
};
