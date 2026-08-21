# Reglas de Seguridad Perimetral, Control de Acceso y Alcance (Scope)

## 1. 🛡️ Seguridad Perimetral y Red Local
- **Validación de Subred / VPN:** Todas las rutas protegidas deben pasar por el `RedLocalMiddleware` antes de permitir el acceso.
- **Uso de `ip-range-check`:** Se debe comprobar que la dirección IP de origen (`req.ip` o cabeceras de proxy inverso) pertenezca a los rangos CIDR corporativos autorizados.
- **Rechazo Temprano:** Si la IP no está dentro del rango corporativo, la petición debe ser rechazada de inmediato con un error `403 Forbidden` sin procesar credenciales ni datos.

---

## 2. 🔑 Autenticación y Autorización
- **Autenticación sin Contraseña (OTP):**
  - Generación y verificación criptográfica de códigos temporales de un solo uso mediante `otplib`.
  - Envío del código OTP exclusivamente al correo corporativo del usuario.
  - Emisión de un token JWT tras la validación exitosa del OTP.
- **Límite de Tasa (Rate Limiting):** Proteger los endpoints de generación y validación de OTP con `@nestjs/throttler` para mitigar ataques de fuerza bruta o saturación de correos.
- **Control de Acceso Basado en Roles (RBAC):**
  - **Administrador:** Acceso completo al sistema y exclusivo al módulo CRUD de usuarios.
  - **Editor:** Operación, configuración y auditoría de flujos y plantillas; sin acceso a la gestión de cuentas de usuario.

---

## 3. 🚫 Delimitación Estricta y Funcionalidades Fuera de Alcance (*Out of Scope*)

Para evitar el crecimiento descontrolado del alcance (*scope creep*), queda estrictamente prohibido implementar:

- ❌ **Ejecución de código arbitrario (*Sandboxing* / `eval`):** La transformación de datos solo se realiza mediante sustitución determinista de variables (`{{nodo.campo}}`) o nodos preprogramados.
- ❌ **Analizadores sintácticos complejos (*AST Parsers*):** No construir analizadores de expresiones personalizadas ni evaluadores de fórmulas dinámicas.
- ❌ **Sistemas Multi-Tenant complejos:** El sistema opera bajo un entorno unificado y cerrado para la organización.
- ❌ **Herramientas de edición o recorte gráfico:** Los archivos adjuntos e imágenes deben ser preparados previamente por el usuario.