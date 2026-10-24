import { Transform } from 'class-transformer';

/**
 * Recorta los espacios de un campo de texto ANTES de validarlo.
 *
 * QUE PROBLEMA RESUELVE. Un correo pegado desde otra aplicacion llega como
 * `" admin@unuware.com "` y no casa con el `@IsEmail` ni con la fila guardada;
 * un nombre con un espacio final se almacena distinto del mismo nombre sin el,
 * y las dos filas se ven identicas en pantalla. Nada de eso es culpa de quien
 * escribe: es ruido del portapapeles.
 *
 * ORDEN DE DECORADORES. Va SIEMPRE por encima de `@MaxLength`, porque
 * `class-transformer` corre antes que `class-validator`: declarado por debajo
 * seguiria funcionando, pero conviene leerlo en el orden en que ocurre.
 * Importa de verdad frente a la longitud —un valor que cabia se rechazaba por
 * los espacios que iban a desaparecer— y frente a `@IsNotEmpty`, que sin esto
 * da por bueno un campo con solo espacios.
 *
 * SOLO TOCA CADENAS. Un numero, un `null` o un `undefined` pasan intactos para
 * que sea el validador siguiente quien los rechace con su propio mensaje; si
 * este decorador los convirtiera, el error hablaria del tipo equivocado.
 */
export const TrimmedString = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );
