import { ref } from 'vue';
import { useQuasar } from 'quasar';

import { parseEmailList } from '@/utils/email-address';

/**
 * Entrada de una lista de destinatarios de correo por chips.
 *
 * Existe porque DOS nodos piden lo mismo —la alerta SMTP y la pausa
 * programada— y las tres vias de entrada (teclear, salir del campo, pegar) no
 * son una sola funcion: son tres politicas distintas que tienen que estar de
 * acuerdo entre si. Duplicarlas en el segundo componente habria dejado dos
 * copias que divergen en silencio, y el sintoma seria que una misma lista
 * pegada produce chips distintos segun el nodo.
 *
 * NO guarda las direcciones: las lee y las escribe en el store del nodo a
 * traves de los dos callbacks. El estado del nodo es suyo (§3.1), y lo unico
 * que vive aqui es lo que el operador esta tecleando y aun no ha confirmado.
 */
export interface RecipientsInputOptions {
  /** Direcciones ya confirmadas, leidas del store del nodo. */
  current: () => readonly string[];
  /** Escribe la lista resultante en el store del nodo. */
  commit: (recipients: string[]) => void;
  /** Tope de direcciones; el backend lo valida con el mismo numero. */
  max: number;
}

export interface RecipientsInput {
  /** Lo tecleado y aun sin confirmar. Se liga a `@input-value`. */
  typed: ReturnType<typeof ref<string>>;
  commitTyped: () => void;
  onKeydown: (event: KeyboardEvent) => void;
  onPaste: (event: ClipboardEvent) => void;
}

export const useRecipientsInput = (options: RecipientsInputOptions): RecipientsInput => {
  const $q = useQuasar();
  const typed = ref('');

  /**
   * Anade direcciones ya validadas, sin repetir y respetando el tope.
   *
   * Centraliza las dos vias de entrada —lo tecleado y lo pegado— para que no
   * puedan divergir: si solo una saneara, el operador tendria una forma de
   * colar basura y ninguna pista de cual de las dos era.
   */
  const add = (candidates: readonly string[]): void => {
    const existing = options.current();
    const merged = [
      ...new Set([...existing, ...candidates].map((address) => address.trim())),
    ].slice(0, options.max);

    if (merged.length === existing.length) return;

    options.commit(merged);
  };

  /**
   * Confirma lo tecleado como chip, avisando si no tiene forma de correo.
   *
   * `notify` es la diferencia con el pegado: aqui el operador ha pulsado Enter
   * o coma, es decir, ha AFIRMADO que eso es una direccion. Descartarla en
   * silencio —como se hace con el ruido de un pegado— dejaria el campo vacio
   * sin explicar por que, que es justo el fallo que el Poka-Yoke debe evitar.
   */
  const commitTyped = (): void => {
    const raw = (typed.value ?? '').trim();

    if (raw === '') return;

    const parsed = parseEmailList(raw);

    if (parsed.length === 0) {
      $q.notify({
        type: 'negative',
        message: `"${raw}" no tiene formato de correo valido`,
      });
      return;
    }

    add(parsed);
    typed.value = '';
  };

  /**
   * Intercepta Enter y la coma para cerrar el chip.
   *
   * La coma entra aqui porque es el separador con el que la gente escribe una
   * lista de correos de memoria; sin interceptarla quedaria DENTRO del chip
   * ("a@x.com,") y el backend devolveria un 400 sobre el esquema entero.
   */
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ',') return;

    // Se corta el comportamiento nativo de QSelect: `new-value-mode`
    // registraria la cadena cruda, sin recortar ni validar, antes que esto.
    event.preventDefault();
    commitTyped();
  };

  /**
   * Intercepta el pegado de una lista de correos.
   *
   * Sin esto, pegar "a@x.com, b@y.com" registraba la cadena ENTERA como una
   * unica direccion: `new-value-mode` no parte por separadores, y el chip
   * resultante solo se descubria invalido al guardar, con un 400 del backend
   * sobre el esquema completo.
   */
  const onPaste = (event: ClipboardEvent): void => {
    const raw = event.clipboardData?.getData('text') ?? '';
    const parsed = parseEmailList(raw);

    // Sin direcciones reconocibles se deja pasar el pegado tal cual: puede ser
    // un correo unico a medio escribir que el operador va a completar a mano, y
    // tragarselo en silencio seria peor que mostrarlo.
    if (parsed.length === 0) return;

    event.preventDefault();
    typed.value = '';
    add(parsed);
  };

  return { typed, commitTyped, onKeydown, onPaste };
};
