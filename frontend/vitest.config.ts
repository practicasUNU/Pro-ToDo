import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Vitest no lee `quasar.config.ts`, asi que los alias se replican aqui. Si se
// anade uno alla, hay que anadirlo tambien en esta lista.
const resolveSrc = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@components': resolveSrc('./src/components'),
      '@stores': resolveSrc('./src/stores'),
      '@services': resolveSrc('./src/services'),
      '@boot': resolveSrc('./src/boot'),
      '@': resolveSrc('./src'),
    },
  },
  test: {
    include: ['src/**/*.spec.ts'],
    // Sin `globals: true` a proposito: activarlo exigiria anadir
    // `vitest/globals` a los `types` de `.quasar/tsconfig.json`, que es un
    // archivo GENERADO por `quasar prepare` y se perderia en cada postinstall.
    // Los helpers se importan explicitamente en cada spec.
    globals: false,
    // Sin entorno DOM: por ahora solo se prueban stores y utilidades puras.
    environment: 'node',
  },
});
