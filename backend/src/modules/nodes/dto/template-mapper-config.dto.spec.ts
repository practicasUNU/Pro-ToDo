import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  MAX_ALLOWED_TAGS,
  MAX_REQUIRED_SELECTORS,
  MAX_SELECTOR_LENGTH,
  TemplateMapperConfigDto,
  resolveTemplateMapperConfig,
} from './template-mapper-config.dto';

import type { ValidatorOptions } from 'class-validator';

const TEMPLATE_ID = '5e2d1c4b-7a89-4f30-b1c2-6d5e4f3a2b10';

/** Las mismas que aplica `PipelineValidatorService`: un campo de mas es un fallo. */
const VALIDATION_OPTIONS: ValidatorOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
};

const validateParams = (params: Record<string, unknown>) =>
  validate(plainToInstance(TemplateMapperConfigDto, params), VALIDATION_OPTIONS);

describe('TemplateMapperConfigDto', () => {
  describe('1. Campos opcionales', () => {
    it('1.1 deberia admitir unos params vacios', async () => {
      // 1. Arrange 📐: una plantilla de flujo declara topologia, no operativa.
      const params = {};

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(0);
    });

    it('1.2 deberia admitir la configuracion completa', async () => {
      // 1. Arrange 📐
      const params = {
        templateId: TEMPLATE_ID,
        requiredSelectors: ['h1.titular', 'div.cuerpo'],
        allowedTags: ['h1', 'div', 'p'],
      };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(0);
    });

    it('1.3 deberia rechazar una clave que no declara el DTO', async () => {
      // 1. Arrange 📐: con `forbidNonWhitelisted`, un `variableMapping` heredado
      //    de la etapa anterior tiene que salir a la luz al guardar.
      const params = { templateId: TEMPLATE_ID, variableMapping: {} };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(1);
      expect(errors[0]?.property).toBe('variableMapping');
    });

    it('1.4 deberia admitir rawTemplate pese a ser un escape de pruebas', async () => {
      // 1. Arrange 📐: omitirlo del DTO convertiria en 400 la semilla del motor.
      const params = { rawTemplate: '<p></p>' };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(0);
    });
  });

  describe('2. templateId', () => {
    it('2.1 deberia rechazar un identificador que no es UUID', async () => {
      // 1. Arrange 📐
      const params = { templateId: 'noticia-basica' };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(1);
      expect(errors[0]?.property).toBe('templateId');
    });

    it('2.2 deberia rechazar la cadena vacia', async () => {
      // 1. Arrange 📐
      const params = { templateId: '' };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(1);
    });
  });

  describe('3. requiredSelectors', () => {
    it('3.1 deberia rechazar algo que no sea un arreglo', async () => {
      // 1. Arrange 📐
      const params = { requiredSelectors: 'h1.titular' };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(1);
      expect(errors[0]?.property).toBe('requiredSelectors');
    });

    it(`3.2 deberia rechazar mas de ${MAX_REQUIRED_SELECTORS} selectores`, async () => {
      // 1. Arrange 📐
      const params = {
        requiredSelectors: Array.from(
          { length: MAX_REQUIRED_SELECTORS + 1 },
          (_value, index) => `.ranura-${index}`,
        ),
      };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(1);
    });

    it('3.3 deberia rechazar un selector mas largo que el techo', async () => {
      // 1. Arrange 📐
      const params = {
        requiredSelectors: [`.${'x'.repeat(MAX_SELECTOR_LENGTH)}`],
      };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(1);
    });

    it('3.4 deberia rechazar un selector vacio', async () => {
      // 1. Arrange 📐
      const params = { requiredSelectors: ['h1.titular', ''] };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(1);
    });
  });

  describe('4. allowedTags', () => {
    it('4.1 deberia rechazar una etiqueta en mayusculas', async () => {
      // 1. Arrange 📐: el saneador trabaja en minusculas y `DIV` no casaria.
      const params = { allowedTags: ['DIV'] };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(1);
      expect(errors[0]?.property).toBe('allowedTags');
    });

    it('4.2 deberia rechazar algo que no es un nombre de etiqueta', async () => {
      // 1. Arrange 📐
      const params = { allowedTags: ['<div>'] };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(1);
    });

    it(`4.3 deberia rechazar mas de ${MAX_ALLOWED_TAGS} etiquetas`, async () => {
      // 1. Arrange 📐
      const params = {
        allowedTags: Array.from(
          { length: MAX_ALLOWED_TAGS + 1 },
          (_value, index) => `tag${index}`,
        ),
      };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(1);
    });

    it('4.4 NO deberia comprobar aqui que la etiqueta este en la lista blanca', async () => {
      // 1. Arrange 📐: `script` es sintacticamente una etiqueta valida. Que la
      //    lista blanca global no la admita lo decide el renderer, que es quien
      //    conoce esa lista; el DTO solo valida la FORMA.
      const params = { allowedTags: ['script'] };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(0);
    });
  });

  describe('5. outputNamespace tolerado', () => {
    it('5.1 deberia admitir su ausencia, que es lo normal hoy', async () => {
      // 1. Arrange 📐: el asistente nunca lo escribe en `params`
      const params = { templateId: TEMPLATE_ID };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(0);
    });

    it('5.2 deberia admitir el campo heredado sin rechazar el esquema', async () => {
      // 1. Arrange 📐: es la razon de existir del campo. Sin declararlo, enlazar
      //    `paramsSchema` convertiria este flujo historico en un 400.
      const params = { templateId: TEMPLATE_ID, outputNamespace: 'rendered_html' };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(0);
    });

    it('5.3 deberia rechazar un namespace que el validador de topologia no aceptaria', async () => {
      // 1. Arrange 📐: tolerar el campo no es tolerar cualquier contenido
      const params = { outputNamespace: 'rendered-html' };

      // 2. Act ⚙️
      const errors = await validateParams(params);

      // 3. Assert 🎯
      expect(errors).toHaveLength(1);
      expect(errors[0]?.property).toBe('outputNamespace');
    });

    it('5.4 NO deberia asomar en la configuracion resuelta', async () => {
      // 1. Arrange 📐 & 2. Act ⚙️: se tolera para no romper el guardado, pero el
      //    namespace efectivo es el del NODO. Exponerlo aqui crearia la segunda
      //    fuente de verdad que el DTO del PROCESADOR_IA prohibe por escrito.
      const config = resolveTemplateMapperConfig({
        templateId: TEMPLATE_ID,
        outputNamespace: 'rendered_html',
      });

      // 3. Assert 🎯
      expect(config).not.toHaveProperty('outputNamespace');
    });
  });

  describe('6. resolveTemplateMapperConfig', () => {
    it('6.1 deberia representar la ausencia sin lanzar', async () => {
      // 1. Arrange 📐 & 2. Act ⚙️
      const config = resolveTemplateMapperConfig({});

      // 3. Assert 🎯
      expect(config).toEqual({
        templateId: '',
        rawTemplate: null,
        requiredSelectors: [],
        allowedTags: [],
      });
    });

    it('6.2 deberia conservar los valores declarados', async () => {
      // 1. Arrange 📐 & 2. Act ⚙️
      const config = resolveTemplateMapperConfig({
        templateId: TEMPLATE_ID,
        requiredSelectors: ['h1.titular'],
        allowedTags: ['h1'],
      });

      // 3. Assert 🎯
      expect(config.templateId).toBe(TEMPLATE_ID);
      expect(config.requiredSelectors).toEqual(['h1.titular']);
      expect(config.allowedTags).toEqual(['h1']);
    });
  });
});
