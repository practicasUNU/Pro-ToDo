import path from 'node:path';

import {
  relativizeStackPaths,
  resolveLogFile,
  sanitizeLogEntry,
} from '@modules/logs/utils/log-file.util';

const LOG_DIR = '/srv/protodo/logs';

describe('log-file.util', () => {
  describe('resolveLogFile', () => {
    it('deberia resolver un fichero del logger dentro de LOG_DIR', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯: el directorio guardado en BD
      //    se descarta; solo vale el nombre.
      expect(resolveLogFile(LOG_DIR, 'logs/execution-2026-10-22.log')).toBe(
        path.join(LOG_DIR, 'execution-2026-10-22.log'),
      );
      expect(resolveLogFile(LOG_DIR, 'logs/fsm-2026-10-21.log')).toBe(
        path.join(LOG_DIR, 'fsm-2026-10-21.log'),
      );
    });

    it('deberia rechazar rutas que no escribio el logger (path traversal)', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(resolveLogFile(LOG_DIR, '../../etc/passwd')).toBeNull();
      expect(resolveLogFile(LOG_DIR, '/etc/shadow')).toBeNull();
      expect(
        resolveLogFile(LOG_DIR, 'logs/execution-2026-10-22.log.bak'),
      ).toBeNull();
      expect(resolveLogFile(LOG_DIR, 'logs/.env')).toBeNull();
      expect(
        resolveLogFile(LOG_DIR, 'logs/execution-2026-10-22.log/..'),
      ).toBeNull();
    });

    it('deberia devolver null sin ruta guardada', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(resolveLogFile(LOG_DIR, null)).toBeNull();
      expect(resolveLogFile(LOG_DIR, undefined)).toBeNull();
      expect(resolveLogFile(LOG_DIR, '')).toBeNull();
    });
  });

  describe('relativizeStackPaths', () => {
    it('deberia recortar las rutas absolutas hasta la carpeta del proyecto', () => {
      // 1. Arrange 📐
      const stack = [
        'AnthropicProviderException: corte',
        '    at AnthropicLlmProvider.toPayload (/var/www/html/UNUWARE/Pro-ToDo/backend/src/modules/nodes/providers/anthropic.ts:310:13)',
        '    at async Promise.all (index 0)',
        '    at Object.<anonymous> (/app/node_modules/typeorm/query.js:5:1)',
        '    at file:///srv/app/dist/main.js:1:1',
        '    at node:internal/process/task_queues:95:5',
      ].join('\n');

      // 2. Act ⚙️
      const relative = relativizeStackPaths(stack);

      // 3. Assert 🎯
      expect(relative).toContain(
        '(src/modules/nodes/providers/anthropic.ts:310:13)',
      );
      expect(relative).toContain('(node_modules/typeorm/query.js:5:1)');
      expect(relative).toContain('at dist/main.js:1:1');
      expect(relative).toContain('node:internal/process/task_queues:95:5');
      expect(relative).not.toContain('/var/www');
      expect(relative).not.toContain('/app/');
    });
  });

  describe('sanitizeLogEntry', () => {
    it('deberia quitar el payload y recortar el stack', () => {
      // 1. Arrange 📐: el payload lleva correos y salidas de IA.
      const entry = {
        executionId: 'exec-1',
        message: 'fallo',
        payload: { raw_email: { body: 'Contenido confidencial' } },
        stackTrace: 'Error\n    at x (/home/srv/backend/src/a.ts:1:1)',
      };

      // 2. Act ⚙️
      const sanitized = sanitizeLogEntry(entry);

      // 3. Assert 🎯
      expect(sanitized).not.toHaveProperty('payload');
      expect(sanitized.stackTrace).toBe('Error\n    at x (src/a.ts:1:1)');
      expect(sanitized.message).toBe('fallo');
      expect(entry).toHaveProperty('payload');
    });
  });
});
