# 🛠️ Skill / Comando: Despliegue de Nginx (Reverse Proxy)

## 📌 Contexto Arquitectónico
Esta habilidad define los pasos exactos para configurar Nginx como proxy inverso para **Proto-Do** (Monolito Modular). 
Garantiza que el frontend (Quasar SPA) y el backend (NestJS) se sirvan bajo un mismo puerto/dominio, evadiendo problemas de CORS, protegiendo las cookies/tokens JWT, y asegurando que el `RedLocalMiddleware` reciba la IP real del cliente para la validación perimetral.

## 🚀 Disparador del Comando
Activar cuando el usuario utilice el comando `/aplicar-nginx` o solicite explícitamente "configurar Nginx", "aplicar proxy inverso" o "preparar entorno de producción HTTP/HTTPS".

---

## 📝 Paso 1: Configurar `trust proxy` en el Backend (NestJS)
Para que `RedLocalMiddleware` evalúe correctamente la IP origen (y no la IP local de Nginx), se debe modificar el archivo de arranque del backend.

**Archivo:** `backend/src/main.ts`
```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // 🔒 Habilitar confianza en el proxy para middlewares de IP / Rate Limiting
  app.set('trust proxy', true);
  
  // (Mantener configuraciones previas de ValidationPipe, CORS, etc.)
  
  await app.listen(3000);
}
bootstrap();
```

---

## 📝 Paso 2: Actualizar Variables de Entorno del Frontend
El cliente Quasar ahora apuntará a la raíz del proxy inverso, eliminando la necesidad de exponer el puerto 3000.

**Archivo:** `frontend/.env`
```env
# URL Base de la API (Ajustar dominio local o IP en producción)
VITE_API_BASE_URL=https://protodo.local/api
```

---

## 📝 Paso 3: Configurar el Bloque de Servidor (Server Block) Nginx
Crear el archivo de configuración en el servidor Linux (Zorin OS / Ubuntu).

**Ruta sugerida:** `/etc/nginx/sites-available/protodo`

```nginx
server {
    listen 80;
    server_name protodo.local; # Reemplazar por IP corporativa o dominio asignado

    # Descomentar en producción para forzar HTTPS:
    # return 301 https://$host$request_uri;

    # 1. Enrutar Interfaz SPA (Quasar)
    location / {
        root /var/www/html/UNUWARE/Pro-ToDo/frontend/dist/spa;
        try_files $uri $uri/ /index.html;
    }

    # 2. Enrutar API REST (NestJS)
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        
        # 🛡️ Cabeceras estrictas para el RedLocalMiddleware
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 3. Enrutar WebSockets (Motor FSM / ExecutionLogService)
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # 🛡️ Cabeceras para trazas
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

---

## 📝 Paso 4: Validar y Reiniciar Servicios
Instruir al usuario para enlazar y reiniciar el demonio web en Zorin OS:

```bash
# Crear enlace simbólico
sudo ln -s /etc/nginx/sites-available/protodo /etc/nginx/sites-enabled/

# Validar sintaxis
sudo nginx -t

# Reiniciar servicio
sudo systemctl reload nginx
```
