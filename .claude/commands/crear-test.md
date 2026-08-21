# Comando: /crear-test <ruta-del-archivo>

Genera o actualiza la suite de pruebas unitarias en Jest para el archivo especificado, aplicando aislamiento estricto mediante mocks y validando su ejecución.

---

## 📋 Instrucciones de Ejecución

1. 🎯 **Identificación del Objetivo:**
   - Si no se proporcionó la ruta del archivo, solicítala: *"Indica la ruta del archivo que deseas probar (ej. `src/strategies/extractor-llm.strategy.ts`):"*.
   - Ubica o crea el archivo de prueba correspondiente con el sufijo `.spec.ts` en el mismo directorio (o en `test/` según la convención del proyecto).

2. 🛡️ **Aislamiento y Mocks (Sin dependencias externas):**
   - Identifica todas las dependencias inyectadas (servicios de red, base de datos, APIs de IA).
   - Genera implementaciones simuladas (*jest.fn()*, *jest.spyOn()*) para garantizar que ninguna prueba realice llamadas HTTP o consultas reales a PostgreSQL.

3. 🧱 **Estructura bajo el Patrón AAA:**
   - Sigue el patrón Arrange-Act-Assert definido en `rules/testing-standards.md`.

4. 🧪 **Casos de Prueba Obligatorios:**
   - 🟢 **Camino feliz (Happy Path):** Ejecución exitosa con datos válidos.
   - 🟡 **Casos límite (Edge Cases):** Entradas vacías, nulas o esquemas incompletos.
   - 🔴 **Manejo de errores:** Simulación de fallos controlados (timeouts, errores de red, respuestas HTTP 5xx).

5. 🚀 **Verificación Automática:**
   - Ejecuta la prueba recién creada:
     ```bash
     npm test -- <ruta-del-archivo.spec.ts>
     ```
   - Si la prueba falla, analiza el error, corrige el archivo de prueba o el código, y vuelve a ejecutar hasta que quede en verde 🟢.