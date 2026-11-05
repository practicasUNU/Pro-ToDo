import { plainToInstance } from 'class-transformer';
import { IsNotEmpty, IsString, validateSync } from 'class-validator';

import { TrimmedString } from '@common/decorators/trimmed-string.decorator';

class SampleDto {
  @TrimmedString()
  @IsString()
  @IsNotEmpty({ message: 'El campo no puede estar vacio.' })
  name: string;
}

/** DTO suelto para comprobar que los no-cadena pasan intactos. */
class LooseDto {
  @TrimmedString()
  value: unknown;
}

describe('TrimmedString', () => {
  it('1.1 deberia recortar los espacios de alrededor', () => {
    // 1. Arrange 📐: es el ruido tipico de un valor pegado desde otra
    //    aplicacion, que no casa ni con el validador ni con la fila guardada.
    // 2. Act ⚙️
    const dto = plainToInstance(SampleDto, { name: '  Plantilla  ' });

    // 3. Assert 🎯
    expect(dto.name).toBe('Plantilla');
  });

  it('1.2 deberia convertir en vacio un campo de solo espacios', () => {
    // 1. Arrange 📐: SIN el recorte, `@IsNotEmpty` da por bueno `"   "` y la
    //    fila se guarda con un nombre que en pantalla no se ve.
    const dto = plainToInstance(SampleDto, { name: '   ' });

    // 2. Act ⚙️
    const errors = validateSync(dto);

    // 3. Assert 🎯
    expect(dto.name).toBe('');
    expect(errors).toHaveLength(1);
  });

  it.each([
    ['un numero', 42],
    ['un nulo', null],
    ['un indefinido', undefined],
    ['un objeto', { a: 1 }],
  ])('1.3 deberia dejar intacto %s', (_label, value) => {
    // 1. Arrange 📐 + 2. Act ⚙️: si el decorador los convirtiera, el error del
    //    validador siguiente hablaria del tipo equivocado.
    const dto = plainToInstance(LooseDto, { value });

    // 3. Assert 🎯
    expect(dto.value).toEqual(value);
  });
});
