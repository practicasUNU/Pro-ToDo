# Comando: /subir-main

Fusiona la rama de trabajo actual en `main` usando un commit explícito (`--no-ff`), ejecuta las pruebas y publica los cambios.

---

## 📋 Instrucciones de Ejecución

1. 🧪 **Validación de Pruebas:**
   - Ejecuta `npm test`.
   - Si alguna prueba falla, **detén el proceso inmediatamente** y muestra el error. No continúes con el merge.

2. 🌿 **Verificación de Rama:**
   - Obtén el nombre de la rama activa con `git branch --show-current`.
   - Si la rama activa es `main`, aborta indicando que ya te encuentras en la rama principal.

3. 🔄 **Actualización y Fusión:**
   - Cambia a la rama principal: `git checkout main`
   - Descarga los últimos cambios: `git pull origin main`
   - Realiza la fusión sin fast-forward:
     ```bash
     git merge --no-ff <nombre-de-la-rama> -m "merge(<nombre-de-la-rama>): integrar funcionalidad en main"
     ```

4. 🚀 **Publicación:**
   - Sube los cambios al repositorio remoto: `git push origin main`

5. 🧹 **Limpieza (Opcional):**
   - Pregunta al usuario si desea eliminar la rama local que acaba de integrarse (`git branch -d <nombre-de-la-rama>`).