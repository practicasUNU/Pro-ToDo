# Comando: /siguiente-paso

Analiza el estado actual del repositorio, revisa la hoja de ruta del proyecto y presenta la siguiente tarea pendiente junto con un plan de acción sugerido.

---

## 📋 Instrucciones de Ejecución

1. 🔍 **Inspección del Repositorio:**
   - Revisa la rama activa con `git branch --show-current`.
   - Comprueba archivos modificados o pendientes con `git status --short`.
   - Lee el historial reciente de commits (`git log -n 5 --oneline`) para entender el último contexto completado.

2. 📖 **Lectura del Plan de Trabajo:**
   - Consulta el archivo de especificaciones o roadmap (`CLAUDE.md`, `docs/plan.md` o la documentación del proyecto).
   - Identifica qué módulos o funcionalidades ya están implementados y cuáles están pendientes (Ingesta, FSM, IA, Conectores, Frontend).

3. 🎯 **Determinación del Siguiente Hito:**
   - Define con claridad el objetivo técnico inmediato a resolver.
   - Si hay tareas a medio terminar en la rama activa, prioriza concluir ese bloque antes de iniciar uno nuevo.

4. 📤 **Presentación del Resumen:**
   - Estructura la respuesta para el desarrollador con:
     - 📌 **Estado Actual:** Breve resumen de lo último realizado.
     - 🎯 **Siguiente Tarea:** Nombre y objetivo del próximo paso.
     - 🛠️ **Propuesta de Implementación:** Lista de 2 a 4 pasos técnicos a seguir.
     - ❓ **Confirmación:** Esperar validación del usuario antes de generar o modificar archivos.