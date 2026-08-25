# Comando: /actualizar-rama <descripción>

Valida el código, crea un commit de tipo `feat` o `refactor` (según aplique) respetando el ámbito de la rama activa y publica los cambios en el repositorio remoto. Es el equivalente de `/hacer-fix` para añadir o actualizar funcionalidad en lugar de corregir errores.

---

## 📋 Instrucciones de Ejecución

1. ✍️ **Captura de la Descripción:**
   - Si el usuario no proporcionó una descripción al invocar el comando, **solicítala antes de continuar**: *"Por favor, ingresa una breve descripción del cambio realizado:"*.

2. 🏷️ **Determinación del Tipo (`feat` vs `refactor`):**
   - Si el usuario indicó explícitamente el tipo, úsalo.
   - Si no, infiere el tipo según la naturaleza del cambio:
     - `feat`: se agrega funcionalidad nueva o comportamiento observable.
     - `refactor`: se reestructura o mejora código existente sin alterar su comportamiento externo.
   - Ante ambigüedad, **pregunta al usuario** cuál de los dos tipos aplica antes de continuar.

3. 🧪 **Validación de Pruebas (Patrón AAA):**
   - Ejecuta `npm test` antes de confirmar cualquier commit.
   - Si alguna prueba falla, **detén el proceso de inmediato** y muestra el error para corregirlo antes de confirmar.

4. 🌿 **Detección del Ámbito (Scope):**
   - Obtén el nombre de la rama activa (`git branch --show-current`).
   - Extrae el sufijo posterior a `feat/`, `fix/` o la convención usada (ejemplo: si la rama es `feat/usuarios`, el ámbito es `usuarios`).

5. 📝 **Creación del Commit:**
   - Agrega los cambios necesarios al área de preparación (`git add .` o archivos afectados).
   - Genera el commit siguiendo estrictamente el estándar de Conventional Commits en español, usando el tipo determinado en el paso 2, para que el hook `commit-msg` no falle:
     ```bash
     git commit -m "feat(<ámbito>): <descripción_proporcionada>"
     ```
     ```bash
     git commit -m "refactor(<ámbito>): <descripción_proporcionada>"
     ```

6. 🚀 **Publicación en Remoto:**
   - Envía los cambios a la rama activa en el servidor:
     ```bash
     git push origin <rama_actual>
     ```
