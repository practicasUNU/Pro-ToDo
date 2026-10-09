import {
  applyEnvironmentCeiling,
  applyEnvironmentFloor,
} from './env-precedence.util';

/** Constante de respaldo, a la altura del defecto real del nodo de IA. */
const FALLBACK = 15_000;

describe('Precedencia entre el nodo y el entorno', () => {
  describe('1. Piso: el entorno manda cuando pide MAS', () => {
    it('1.1 deberia elevar un valor guardado por debajo del entorno', () => {
      // 1. Arrange 📐: EL caso. Un flujo creado por el asistente lleva
      //    `timeoutMs: 15000` clavado en su JSONB y el `.env` pide 60 000; con
      //    la precedencia normal, la variable no alcanzaba al unico flujo que
      //    la necesitaba.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(applyEnvironmentFloor(15_000, 60_000, FALLBACK)).toBe(60_000);
    });

    it('1.2 deberia respetar un valor guardado por encima del entorno', () => {
      // 1. Arrange 📐: es un PISO, no una imposicion. Un nodo que pidio mas
      //    espera sabe algo que el `.env` no sabe.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(applyEnvironmentFloor(120_000, 60_000, FALLBACK)).toBe(120_000);
    });

    it('1.3 deberia tomar el entorno cuando el nodo no declara nada', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(applyEnvironmentFloor(undefined, 60_000, FALLBACK)).toBe(60_000);
    });

    it('1.4 NO deberia haber piso cuando el entorno calla', () => {
      // 1. Arrange 📐: la guarda que hace inocuo el cambio. Sin ella habria que
      //    usar la constante de respaldo como piso, y un flujo que eligio a
      //    proposito una espera corta subiria al defecto sin que nadie hubiera
      //    tocado el `.env`.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(applyEnvironmentFloor(5_000, null, FALLBACK)).toBe(5_000);
      expect(applyEnvironmentFloor(undefined, null, FALLBACK)).toBe(FALLBACK);
    });
  });

  describe('2. Techo: el entorno manda cuando pide MENOS', () => {
    it('2.1 deberia recortar un valor guardado por encima del entorno', () => {
      // 1. Arrange 📐: con los reintentos el riesgo cambia de lado. Se
      //    multiplican por la cadena de respaldo de proveedores y cada vuelta
      //    factura tokens, asi que el administrador necesita poder CONTENER un
      //    flujo que guardo cinco.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(applyEnvironmentCeiling(5, 1, 3)).toBe(1);
    });

    it('2.2 deberia respetar un valor guardado por debajo del entorno', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(applyEnvironmentCeiling(0, 2, 3)).toBe(0);
    });

    it('2.3 deberia admitir el CERO del entorno como techo legitimo', () => {
      // 1. Arrange 📐: `0` significa "no reintentes" y tiene que sobrevivir al
      //    recorte. Un `??` en lugar del `Math.min` lo trataria como ausencia.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(applyEnvironmentCeiling(3, 0, 3)).toBe(0);
      expect(applyEnvironmentCeiling(undefined, 0, 3)).toBe(0);
    });

    it('2.4 NO deberia haber techo cuando el entorno calla', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(applyEnvironmentCeiling(5, null, 3)).toBe(5);
      expect(applyEnvironmentCeiling(undefined, null, 3)).toBe(3);
    });
  });
});
