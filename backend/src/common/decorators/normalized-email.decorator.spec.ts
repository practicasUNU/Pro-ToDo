import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { NormalizedEmail } from '@common/decorators/normalized-email.decorator';
import { RequestOtpDto } from '@modules/auth/dto/request-otp.dto';
import { VerifyOtpDto } from '@modules/auth/dto/verify-otp.dto';

/** DTO suelto para comprobar que los no-cadena pasan intactos. */
class LooseDto {
  @NormalizedEmail()
  value: unknown;
}

describe('NormalizedEmail', () => {
  it('1.1 deberia recortar y pasar a minusculas el correo', () => {
    // 1. Arrange 📐: correo pegado con espacios y mayusculas.
    // 2. Act ⚙️
    const dto = plainToInstance(LooseDto, { value: '  Admin@UNUWARE.com ' });

    // 3. Assert 🎯
    expect(dto.value).toBe('admin@unuware.com');
  });

  it.each([
    ['un numero', 42],
    ['un nulo', null],
    ['un indefinido', undefined],
  ])('1.2 deberia dejar intacto %s', (_label, value) => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const dto = plainToInstance(LooseDto, { value });

    // 3. Assert 🎯
    expect(dto.value).toBe(value);
  });
});

describe('RequestOtpDto / VerifyOtpDto (email)', () => {
  it('2.1 deberia aceptar un correo con espacios y mayusculas, ya normalizado', () => {
    // 1. Arrange 📐
    const raw = { email: '  Usuario@UNUWARE.com  ' };

    // 2. Act ⚙️
    const dto = plainToInstance(RequestOtpDto, raw);
    const errors = validateSync(dto);

    // 3. Assert 🎯
    expect(errors).toHaveLength(0);
    expect(dto.email).toBe('usuario@unuware.com');
  });

  it('2.2 deberia normalizar el correo tambien al validar el codigo', () => {
    // 1. Arrange 📐
    const raw = {
      email: ' Usuario@UNUWARE.com',
      code: '123456',
      deviceId: 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
    };

    // 2. Act ⚙️
    const dto = plainToInstance(VerifyOtpDto, raw);
    const errors = validateSync(dto);

    // 3. Assert 🎯
    expect(errors).toHaveLength(0);
    expect(dto.email).toBe('usuario@unuware.com');
  });

  it('2.3 deberia rechazar un cuerpo sin correo con los dos mensajes del 400 reportado', () => {
    // 1. Arrange 📐: es lo que veia el DTO cuando el parser JSON global no
    //    estaba montado: `email` indefinido, no una cadena mal formada.
    const dto = plainToInstance(RequestOtpDto, {});

    // 2. Act ⚙️
    const errors = validateSync(dto);

    // 3. Assert 🎯
    expect(errors).toHaveLength(1);
    expect(Object.keys(errors[0].constraints ?? {})).toEqual(
      expect.arrayContaining(['isEmail', 'maxLength']),
    );
  });
});
