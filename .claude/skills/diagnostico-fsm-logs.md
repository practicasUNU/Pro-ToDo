# Habilidad: Diagnóstico de Errores y Logs de la FSM

Esta habilidad define el procedimiento para que la IA investigue incidentes de ejecución en Proto-Do y presente un reporte estructurado y pedagógico del fallo.

---

## 📋 Procedimiento de Inspección

1. 🔍 **Localizar el Registro en PostgreSQL:**
   - Buscar en la tabla de ejecuciones/alertas usando el `execution_id`.
   - Extraer: `flow_id`, `current_state` (`PAUSADO` o `FALLIDO`), nivel de severidad (`LEVE`, `GRAVE`, `URGENTE`), `active_cursor` y la ruta del archivo `log_path`.

2. 📂 **Leer el Archivo Físico (`.log`):**
   - Abrir el archivo referenciado en disco (`/var/log/...` o ruta configurada).
   - Extraer el *stack trace* y el objeto `StatePayloadContext` del paso donde ocurrió la excepción.

3. 🩺 **Analizar la Causa Raíz:**
   - Identificar si se trata de datos faltantes, rechazo de esquema, timeout o caída de servicio externo.

---

## 📤 Formato Obligatorio del Reporte de Diagnóstico

Cuando se active esta habilidad o se solicite analizar un fallo, la respuesta debe estructurarse con las siguientes secciones:

- 📍 **Origen del Fallo:**
  - **ID de Ejecución:** `<execution_id>`
  - **Paso / Cursor Activo:** `<nombre_del_nodo>`
  - **Severidad:** `LEVE` | `GRAVE` | `URGENTE`
  - **Archivo de Log Asociado:** `<ruta_absoluta_al_archivo.log>`

- 📦 **Carga Útil en Conflicto (Payload Snippet):**
  ```json
  // Fragmento exacto del StatePayloadContext recibido por el nodo que falló