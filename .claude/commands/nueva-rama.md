# Comando: /nueva-rama <nombre-feature>

Crea una nueva rama de trabajo asegurando que el espacio de trabajo esté limpio y que la rama base `main` esté completamente actualizada.

---

## 📋 Instrucciones de Ejecución

1. 🔍 **Verificación del Árbol de Trabajo:**
   - Ejecuta `git status --porcelain`.
   - Si existen cambios sin confirmar o archivos sin seguimiento, **detén el proceso** y advierte al usuario para que guarde o descarte sus cambios antes de cambiar de contexto.

2. 🔄 **Actualización de la Rama Base:**
   - Cambia a la rama principal:
     ```bash
     git checkout main
     ```
   - Descarga los últimos cambios del repositorio remoto:
     ```bash
     git pull origin main
     ```

3. 🌿 **Creación de la Nueva Rama:**
   - Normaliza el nombre recibido como argumento eliminando espacios o caracteres especiales (ejemplo: `modulo-ingesta`).
   - Crea y salta a la nueva rama usando el prefijo estándar:
     ```bash
     git checkout -b feat/<nombre-feature>
     ```

4. 📢 **Confirmación:**
   - Muestra un mensaje informando que la rama `feat/<nombre-feature>` está activa y lista para trabajar.