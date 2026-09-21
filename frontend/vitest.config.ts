import { fileURLToPath } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

// Vitest no lee `quasar.config.ts`, asi que los alias se replican aqui. Si se
// anade uno alla, hay que anadirlo tambien en esta lista.
const resolveSrc = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // Necesario para montar componentes: sin el, Vite no sabe compilar un `.vue` y
  // el spec falla al importarlo, no al aseverar.
  plugins: [vue()],
  resolve: {
    // Vitest resuelve la condicion de exportacion `node`, que en Quasar apunta a
    // su build de SSR: ese no instala los componentes y `mount` revienta con un
    // "Cannot convert undefined or null to object" que no dice nada de su causa.
    // Se fuerza el build de cliente, que es el que corre en el navegador real.
    alias: {
      quasar: fileURLToPath(
        new URL('./node_modules/quasar/dist/quasar.client.js', import.meta.url),
      ),
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
    // `node` como defecto: la mayoria de los specs prueban stores y utilidades
    // puras, que no necesitan DOM y arrancan mas rapido sin el. Los specs que SI
    // montan un componente lo declaran por archivo con la directiva
    // `// @vitest-environment happy-dom` en su cabecera, para no imponer el coste
    // —ni el `window` global— a los demas.
    environment: 'node',
  },
});
