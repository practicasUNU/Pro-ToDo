# Habilidad: Diagnóstico y Resolución de Problemas de Docker (PostgreSQL)

Esta habilidad define el protocolo para depurar incidencias del contenedor de PostgreSQL 16 gestionado vía `docker-compose.yml`, incluyendo conflictos de puerto, permisos de volumen y reinicialización limpia.

---

## 🔍 1. Áreas de Diagnóstico Clave

### 🔌 A. Conflicto de Puerto 5432 (Instancia Nativa de PostgreSQL)

- **Síntoma:** `docker compose up -d` falla con `port is already allocated` o el backend no logra conectar aunque el contenedor esté "Up".
- **Verificación:**
  ```bash
  sudo ss -tulpn | grep 5432
  systemctl status postgresql
  ```
- **Corrección:** Detener y deshabilitar la instancia nativa del host para que el puerto quede libre exclusivamente para el contenedor:
  ```bash
  sudo systemctl stop postgresql
  sudo systemctl disable postgresql
  ```

### 💾 B. Permisos y Volumen Persistente (`pgdata/`)

- **Síntoma:** El contenedor reinicia en bucle (`docker compose logs -f postgres`) por errores de permisos en `PGDATA` o el volumen quedó corrupto tras un cierre abrupto.
- **Verificación:**
  ```bash
  docker compose ps
  docker compose logs -f postgres
  ls -la ./pgdata
  ```
- **Reinicialización limpia (desarrollo):** Elimina el contenedor, la red y el volumen con datos, y vuelve a levantar desde cero:
  ```bash
  docker compose down -v
  docker compose up -d
  ```
  ⚠️ **Destructivo:** `down -v` borra todos los datos de `protodo_db`. Usar solo en entornos de desarrollo y con confirmación previa del usuario.

---

## 📤 Formato de Respuesta ante Errores de Docker

1. ⚠️ **Tipo de Fallo Detectado:** (Conflicto de Puerto | Permisos de Volumen | Contenedor Caído).
2. 🔍 **Diagnóstico:** Comando ejecutado (`docker compose ps`, `docker compose logs -f postgres`, `ss -tulpn`) y su salida relevante.
3. 🛠️ **Comando de Solución:** Instrucción exacta en Bash para corregir la incidencia, marcando cualquier paso destructivo antes de ejecutarlo.
