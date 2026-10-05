import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  DEFAULT_POST_IA_SOURCE_FIELD,
  DEFAULT_POST_IA_SOURCE_NAMESPACE,
  PostIaSanitizerConfigDto,
  resolvePostIaSanitizerConfig,
} from './post-ia-sanitizer-config.dto';
import {
  MAX_ALLOWED_TAGS,
  MAX_REQUIRED_SELECTORS,
  MAX_SELECTOR_LENGTH,
} from './template-mapper-config.dto';

import type { ValidatorOptions } from 'class-validator';

/** Las mismas que aplica `PipelineValidatorService`: un campo de mas es un fallo. */
const VALIDATION_OPTIONS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

const validateParams = (params: Record<string, unknown>) =>
  validate(
    plainToInstance(PostIaSanitizerConfigDto, params),
    VALIDATION_OPTIONS,
  );

describe('PostIaSanitizerConfigDto', () => {
  describe('1. Campos opcionales', () => {
    it('1.1 deberia admitir un objeto vacio', async () => {
      // 1. Arrange 📐: una plantilla de flujo declara topologia, no operativa, y
      //    se guarda con `params: {}`. El mismo DTO la valida a ella y al flujo.
      const params = {};

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(0);
    });

    it('1.2 deberia admitir la configuracion completa', async () => {
      // 1. Arrange 📐
      const params = {
        sourceNamespace: 'llm_response',
        sourceField: 'filled_markup',
        requiredSelectors: ['h1.titular', 'div.cuerpo'],
        allowedTags: ['h1', 'p', 'div'],
      };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(0);
    });

    it('1.3 deberia rechazar una clave que el DTO no declara', async () => {
      // 1. Arrange 📐: `schemaId` es la clave que el fixture historico del
      //    validador atribuia a este nodo. Con `forbidNonWhitelisted` tiene que
      //    salir a la luz AL GUARDAR, no en ejecucion.
      const params = { schemaId: 'noticia_v1' };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('schemaId');
    });

    it('1.4 NO deberia declarar outputNamespace', async () => {
      // 1. Arrange 📐: el namespace efectivo es el del NODO en el
      //    pipeline_schema. Declararlo aqui seria una segunda fuente de verdad
      //    que el validador de topologia no ve.
      const params = { outputNamespace: 'validated_drupal_json' };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('outputNamespace');
    });
  });

  describe('2. sourceNamespace', () => {
    it.each(['Llm_Response', 'llm-response', 'llm response', 'llm.response'])(
      '2.1 deberia rechazar %p por no ser snake_case en minusculas',
      async (sourceNamespace) => {
        // 1. Arrange 📐: el namespace es la raiz de un `{{ns.campo}}`, y la
        //    expresion de sustitucion del motor solo reconoce [a-zA-Z0-9_].
        const params = { sourceNamespace };

        // 2. Act ⚙️
        const errors = await validateParams(params);

        // 3. Assert 🎯
        expect(errors).toHaveLength(1);
        expect(errors[0].property).toBe('sourceNamespace');
      },
    );

    it('2.2 deberia admitir un namespace distinto del defecto', async () => {
      // 1. Arrange 📐: el escudo no esta atado a `llm_response`; puede auditar
      //    lo que publique cualquier nodo anterior.
      const params = { sourceNamespace: 'ocr_result' };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(0);
    });
  });

  describe('3. sourceField', () => {
    it.each(['filledMarkup', 'filled-markup', 'Filled_Markup'])(
      '3.1 deberia rechazar %p por no ser snake_case en minusculas',
      async (sourceField) => {
        // 1. Arrange 📐: mismo motivo que el namespace; juntos forman la ruta
        //    `{{ns.campo}}` que el motor tiene que saber resolver.
        const params = { sourceField };

        // 2. Act ⚙️
        const errors = await validateParams(params);

        // 3. Assert 🎯
        expect(errors).toHaveLength(1);
        expect(errors[0].property).toBe('sourceField');
      },
    );

    it('3.2 deberia rechazar un valor que no sea cadena', async () => {
      // 1. Arrange 📐: `pipeline_schema` es una columna jsonb y pudo escribirse
      //    por SQL directo, asi que un numero es alcanzable.
      const params = { sourceField: 42 };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('sourceField');
    });
  });

  describe('4. requiredSelectors', () => {
    it('4.1 deberia rechazar una lista mas larga que el tope', async () => {
      // 1. Arrange 📐: el tope es de diagnostico. Treinta selectores suelen
      //    significar que alguien describe la plantilla entera, no sus ranuras.
      const params = {
        requiredSelectors: Array.from(
          { length: MAX_REQUIRED_SELECTORS + 1 },
          (_, index) => `.ranura-${index}`,
        ),
      };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(1);
      expect(Object.values(errors[0].constraints ?? {})).toContain(
        `requiredSelectors no puede declarar mas de ${MAX_REQUIRED_SELECTORS} selectores.`,
      );
    });

    it('4.2 deberia rechazar un selector vacio', async () => {
      // 1. Arrange 📐
      const params = { requiredSelectors: ['h1.titular', ''] };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('requiredSelectors');
    });

    it('4.3 deberia rechazar un selector mas largo que el tope', async () => {
      // 1. Arrange 📐
      const params = {
        requiredSelectors: ['a'.repeat(MAX_SELECTOR_LENGTH + 1)],
      };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('requiredSelectors');
    });
  });

  describe('5. allowedTags', () => {
    it('5.1 deberia rechazar una lista mas larga que el tope', async () => {
      // 1. Arrange 📐
      const params = {
        allowedTags: Array.from(
          { length: MAX_ALLOWED_TAGS + 1 },
          (_, index) => `tag${index}`,
        ),
      };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(1);
      expect(Object.values(errors[0].constraints ?? {})).toContain(
        `allowedTags no puede declarar mas de ${MAX_ALLOWED_TAGS} etiquetas.`,
      );
    });

    it.each(['H1', 'div.clase', '<p>', '1h'])(
      '5.2 deberia rechazar %p por no ser un nombre de etiqueta',
      async (tag) => {
        // 1. Arrange 📐: el saneador escribe las etiquetas en minusculas, y una
        //    que no coincida seria un recorte silenciosamente inerte.
        const params = { allowedTags: [tag] };

        // 2. Act ⚙️
        const errors = await validateParams(params);

        // 3. Assert 🎯
        expect(errors).toHaveLength(1);
        expect(errors[0].property).toBe('allowedTags');
      },
    );
  });

  describe('6. resolvePostIaSanitizerConfig', () => {
    it('6.1 deberia aplicar los defectos sobre un DTO vacio', () => {
      // 1. Arrange 📐
      const dto = plainToInstance(PostIaSanitizerConfigDto, {});

      // 2. Act ⚙️
      const config = resolvePostIaSanitizerConfig(dto);

      // 3. Assert 🎯
      expect(config).toEqual({
        sourceNamespace: DEFAULT_POST_IA_SOURCE_NAMESPACE,
        sourceField: DEFAULT_POST_IA_SOURCE_FIELD,
        requiredSelectors: [],
        allowedTags: [],
      });
    });

    it('6.2 deberia respetar un origen declarado explicitamente', () => {
      // 1. Arrange 📐
      const dto = plainToInstance(PostIaSanitizerConfigDto, {
        sourceNamespace: 'ocr_result',
        sourceField: 'transcribed_markup',
      });

      // 2. Act ⚙️
      const config = resolvePostIaSanitizerConfig(dto);

      // 3. Assert 🎯
      expect(config.sourceNamespace).toBe('ocr_result');
      expect(config.sourceField).toBe('transcribed_markup');
    });

    it('6.3 deberia leer el defecto del campo como filled_markup', () => {
      // 1. Arrange & 2. Act ⚙️: se fija en una prueba porque es el contrato que
      //    el modo de salida HTML del PROCESADOR_IA tendra que cumplir, y hoy
      //    todavia no cumple nadie.
      const config = resolvePostIaSanitizerConfig(
        plainToInstance(PostIaSanitizerConfigDto, {}),
      );

      // 3. Assert 🎯
      expect(config.sourceField).toBe('filled_markup');
    });
  });
});
