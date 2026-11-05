import {
  resolveModelAvailability,
  type LlmModelAvailability,
  type LlmModelDescriptor,
  type LlmModelOption,
  type LlmProvider,
} from '@/types/nodes/llm-extractor.types';
import { UserRole } from '@/types/user';

/**
 * Opciones del selector de modelo, compartidas por los dos nodos que consumen
 * un LLM (`PROCESADOR_IA` y `PROCESADOR_OCR`).
 *
 * Funcion PURA en `utils/` y no un computed duplicado en cada store porque las
 * tres reglas que aplica —ordenar, conservar el modelo guardado y marcar lo
 * restringido— tienen que ser identicas en los dos selectores. Duplicadas, la
 * segunda copia se queda vieja en cuanto una cambia, y el sintoma seria un
 * modelo de pago seleccionable en un nodo y no en el otro.
 *
 * EL MODELO GUARDADO SIEMPRE APARECE, aunque el catalogo no lo incluya ni
 * pertenezca al proveedor elegido. Sin esto, un selector cerrado dejaria en
 * blanco la configuracion de cualquier flujo que apunte a un modelo retirado de
 * la tabla curada —y el `.env` de esta instalacion ya puede traer uno por
 * `AI_DEFAULT_MODEL`—, de modo que abrir el paso para mirarlo bastaria para
 * romperlo al guardar.
 *
 * FILTRA POR PROVEEDOR. El catalogo trae los modelos de los cuatro
 * proveedores juntos, asi que sin esto el selector ofrecia `gemini-3.6-flash`
 * con ANTHROPIC elegido: una combinacion que el backend rechaza al guardar y
 * que, hasta entonces, se ve perfectamente valida. El descriptor ya trae
 * `provider`, de modo que el filtro es exacto y no una heuristica sobre el
 * nombre del modelo.
 *
 * `disable` es COMODIDAD, no una barrera: quien decide es el backend al
 * guardar el flujo. Aqui solo se evita que el operador rellene un formulario
 * entero para toparse con un 403.
 */
export const buildModelOptions = (
  descriptors: readonly LlmModelDescriptor[],
  currentModel: string,
  currentProvider: LlmProvider,
  isAdmin: boolean,
): LlmModelOption[] => {
  const catalogued = descriptors
    .filter((descriptor) => descriptor.provider === currentProvider)
    .map<LlmModelOption>((descriptor) => ({
      label: descriptor.label,
      value: descriptor.model,
      provider: descriptor.provider,
      availability: resolveModelAvailability(descriptor),
      contextWindow: descriptor.contextWindow,
      isUncatalogued: false,
      disable: descriptor.minRoleRequired === UserRole.ADMIN && !isAdmin,
    }));

  const current = currentModel.trim();
  const isListed = current === '' || catalogued.some((option) => option.value === current);

  const options = isListed
    ? catalogued
    : [
        ...catalogued,
        {
          label: `${current} (no catalogado)`,
          value: current,
          provider: currentProvider,
          // No se puede afirmar que este configurado: el backend no lo conoce,
          // asi que no ha podido comprobar ninguna credencial.
          availability: 'MISSING_KEY' as LlmModelAvailability,
          contextWindow: 0,
          isUncatalogued: true,
          // NUNCA deshabilitado: es el valor que el flujo ya tiene guardado, y
          // bloquearlo impediria abrir el paso para cambiarlo por otro.
          disable: false,
        },
      ];

  // Estable y sin mutar el array de origen: `sort` ordena en el sitio, y
  // hacerlo sobre `catalogued` reordenaria el estado en cada recalculo.
  return [...options].sort(
    (left, right) =>
      Number(right.availability === 'AVAILABLE') - Number(left.availability === 'AVAILABLE'),
  );
};

/** ¿El modelo elegido esta vetado para el rol actual? */
export const isModelForbidden = (options: readonly LlmModelOption[], model: string): boolean =>
  options.find((option) => option.value === model.trim())?.disable === true;
