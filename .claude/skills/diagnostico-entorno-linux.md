# Habilidad: Diagnóstico de Entorno Linux y Dependencias

Esta habilidad define el protocolo para depurar incidencias del sistema operativo (Zorin OS / Linux), permisos en `/var/www/html/`, servidores web y gestores de paquetes (NPM).

---

## 🔍 1. Áreas de Diagnóstico Clave

### 🔒 A. Permisos y Propiedad de Archivos
- **Ubicación Crítica:** `/var/www/html/UNUWARE/Pro-ToDo/`
- **Verificación:**
  - Comprobar que los archivos pertenezcan al usuario activo y no a `root` (`ls -la`).
  - Asegurar permisos de ejecución en scripts y hooks: `chmod +x .git/hooks/*`.
  - Asegurar permisos de escritura para la generación de archivos físicos `.log`.
- **Corrección Típica:**
  ```bash
  sudo chown -R $USER:$USER /var/www/html/UNUWARE/Pro-ToDo/

```

### 🌐 B. Puertos y Servidores Web (Apache / NestJS)

* **Verificación de Conflictos:**
* Comprobar si Apache u otro servicio está ocupando los puertos de desarrollo (ej. 3000, 8080, 5432):
```bash
sudo ss -tulpn | grep -E ':(3000|5432|80|443)'

```


* Estado del servicio Apache:
```bash
systemctl status apache2

```
### 📦 C. Dependencias y Paquetes (Node.js / NPM)

* **Verificación de Versión:** Asegurar concordancia con Node.js v24.x y npm 11.x (`node -v`, `npm -v`).
* **Conflictos en `package-lock.json` o Caché:**
* Limpieza controlada ante errores de instalación o dependencias corruptas:
```bash
npm cache clean --force
rm -rf node_modules package-lock.json
npm install

```
---

## 📤 Formato de Respuesta ante Errores de Entorno

Cuando se detecte que la causa raíz es del sistema operativo o dependencias, la respuesta debe incluir:

1. ⚠️ **Tipo de Fallo Detectado:** (Permisos | Conflicto de Puerto / Apache | Discrepancia NPM).
2. 🔍 **Diagnóstico y Comando de Verificación:** Comando ejecutado o sugerido para comprobar el estado.
3. 🛠️ **Comando de Solución:** Instrucción exacta en Bash para corregir la incidencia.
