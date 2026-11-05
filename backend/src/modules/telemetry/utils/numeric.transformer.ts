import type { ValueTransformer } from 'typeorm';

/**
 * Columna `NUMERIC` <-> `number`.
 *
 * El driver `pg` devuelve `NUMERIC` como `string` para no perder precision, y
 * sin este transformer el tipo de la propiedad mentiria: `costo + 1` acabaria
 * concatenando. Las tarifas y los costes de telemetria tienen 6 decimales, muy
 * por debajo del limite de precision de un `double`, asi que convertir es seguro.
 */
export const numericTransformer: ValueTransformer = {
  to: (value: number | null | undefined): number | null | undefined => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};
