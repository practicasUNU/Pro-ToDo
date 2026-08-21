# Comando: /hacer-fix <descripción>

Valida el código, crea un commit de tipo `fix` respetando el ámbito de la rama activa y publica los cambios en el repositorio remoto.

---

## 📋 Instrucciones de Ejecución

1. ✍️ **Captura de la Descripción:**
   - Si el usuario no proporcionó una descripción al invocar el comando, **solicítala antes de continuar**: *"Por favor, ingresa una breve descripción del error corregido:"*.

2. 🧪 **Validación de Pruebas:**
   - Ejecuta `npm test`.
   - Si alguna prueba falla, **detén el proceso de inmediato** y muestra el error para corregirlo antes de confirmar.

3. 🌿 **Detección del Ámbito (Scope):**
   - Obtén el nombre de la rama activa (`git branch --show-current`).
   - Extrae el sufijo posterior a `feat/`, `fix/` o la convención usada (ejemplo: si la rama es `feat/nodo-imap`, el ámbito es `nodo-imap`).

4. 📝 **Creación del Commit:**
   - Agrega los cambios necesarios al área de preparación (`git add .` o archivos afectados).
   - Genera el commit siguiendo el estándar de Conventional Commits en español:
     ```bash
     git commit -m "fix(<ámbito>): <descripción_proporcionada>"
     ```

5. 🚀 **Publicación en Remoto:**
   - Envía los cambios a la rama activa en el servidor:
     ```bash
     git push origin <rama_actual>
     ```