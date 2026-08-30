# Reglas de Arquitectura Frontend (Vue 3 / Quasar)

## 1. 🌐 Capa de Servicios (`src/services/`)

- **Ubicación obligatoria de las llamadas HTTP:** Toda petición a la API del backend (usando Axios, vía `@boot/axios`) debe residir exclusivamente en archivos dentro de `src/services/` (ej. `users.service.ts`).
- **Prohibiciones estrictas:**
  - ❌ Llamadas HTTP directas (`api.get`, `api.post`, etc.) dentro de componentes `.vue`.
  - ❌ Llamadas HTTP directas dentro de stores de Pinia (`src/stores/`).
- **Convención de archivo:** un servicio por entidad/dominio (`users.service.ts`, `flujos.service.ts`), exportando funciones puras que reciben parámetros tipados y retornan la data ya parseada (`response.data`), nunca la respuesta cruda de Axios.
- **Frontera de conocimiento:** el servicio es la única capa que conoce las rutas del backend (`/users`, `/users/:id`) y el tipo `AxiosResponse`. Ninguna otra capa construye URLs ni desestructura respuestas de Axios.
- **Alias de importación:** los servicios se importan vía `@services/users.service` (alias declarado en `build.alias` de `quasar.config.ts`). Recordatorio: `@types` sigue siendo inviable como alias porque TypeScript reserva ese prefijo para `node_modules/@types` (error TS6137); los tipos se importan como `@/types/user`.

```typescript
// src/services/users.service.ts
import { api } from '@boot/axios';

import type { CreateUserPayload, UpdateUserPayload, User } from '@/types/user';

export const fetchUsers = async (): Promise<User[]> => {
  const { data } = await api.get<User[]>('/users');
  return data;
};

export const createUser = async (payload: CreateUserPayload): Promise<User> => {
  const { data } = await api.post<User>('/users', payload);
  return data;
};

export const updateUser = async (id: string, payload: UpdateUserPayload): Promise<User> => {
  const { data } = await api.patch<User>(`/users/${id}`, payload);
  return data;
};

export const deactivateUser = async (id: string): Promise<User> => {
  const { data } = await api.delete<User>(`/users/${id}`);
  return data;
};
```

---

## 2. 🔄 Flujo de Datos Obligatorio

El flujo de una operación contra el backend sigue estrictamente esta cadena, sin saltarse capas:

```
Componente .vue --dispatch--> Accion de Pinia --invoca--> Servicio (src/services/)
                                                                 |
                                                                 v
                                                    Peticion HTTP + data parseada
                                                                 |
                                                                 v
                                              Pinia muta el estado con el resultado
```

- El **componente** solo llama acciones del store (`usersStore.fetchUsers()`) y reacciona al estado (`usersStore.users`, `usersStore.isLoading`); nunca importa un servicio directamente.
- La **accion de Pinia** invoca la funcion correspondiente de `src/services/`, gestiona `isLoading` y muta el estado (`users.value = ...`) con el resultado ya parseado.
- El **servicio** es la unica capa que conoce Axios y las rutas del backend; no conoce Pinia ni componentes.

---

## 2.1 🧱 Responsabilidad por Capa

Cada capa tiene un único motivo para cambiar. Esta tabla es la fuente de verdad ante cualquier duda de "¿dónde va esta lógica?":

| Capa | Sí le corresponde | Prohibido |
|---|---|---|
| `src/services/*.service.ts` | Rutas del backend, verbos HTTP, tipado de request/response, devolver `response.data` ya parseado | Conocer Pinia o componentes; guardar estado; formatear para la vista |
| `src/stores/*.store.ts` | **Lógica de negocio** y estado compartido: `isLoading`, colecciones, invariantes de dominio, mutación inmutable con el resultado del servicio | Importar Axios o `@boot/axios`; construir URLs; conocer componentes concretos |
| Componente `.vue` | **Lógica propia de ese formulario o diálogo**: estado local de UI (apertura, `form` reactivo, reglas de validación, temporizadores), feedback con `$q.notify` / `$q.dialog`; invoca acciones del store cuando necesita persistir o leer del backend | Importar un servicio directamente; llamar a Axios |
| `src/utils/*.ts` | Helpers puros de presentación y formato (derivar un nombre a mostrar, formatear fechas), sin estado ni I/O | Cualquier efecto de red o dependencia de Pinia |

- **Criterio de desempate:** si la lógica solo tiene sentido dentro de un componente y muere con él (validar un campo, contar 5 segundos), vive en el componente. Si otra vista podría necesitar el mismo resultado o el mismo estado, sube al store.
- **Las excepciones se propagan hacia arriba:** el servicio no captura errores HTTP y el store tampoco (solo garantiza el `finally` que apaga `isLoading`); es el componente quien decide el mensaje al usuario.

---

## 3. 🧩 Patron de Reusabilidad: Layouts vs Componentes

- **Abstraccion en Layouts (`src/layouts/`):** cuando una estructura visual general (menus laterales, cabeceras, `q-drawer`, `q-header`) envuelve multiples vistas que solo cambian en su contenido central (`router-view`). Un layout se referencia desde `src/router/routes.ts` como componente padre de un grupo de rutas.
- **Abstraccion en Componentes (`src/components/`):** cuando un bloque de interfaz especifico (tablas custom, modales, tarjetas) se repite en el sistema o concentra logica interna que muta segun props (ej. `SafeDeleteModal.vue`, `UserDialog.vue`). Se organiza por dominio (`src/components/users/`, `src/components/flujos/`).
- **Helpers puros (`src/utils/`):** cuando la reutilizacion no es un bloque de interfaz sino una transformacion de datos sin estado (ej. `deriveDisplayName(email)` para mostrar un nombre legible a partir del correo). No son componentes ni stores: funciones puras, testeables de forma aislada e importadas donde se necesiten (ver seccion 2.1).
- **Regla de decision rapida:** si el elemento envuelve rutas → Layout. Si el elemento vive dentro de una ruta y se repite o tiene logica propia → Componente. Si no pinta nada y solo transforma un valor → `src/utils/`.

---

## 4. 📁 Estructura de Enrutamiento

- El enrutador usa `src/router/routes.ts` (arreglo explicito de `RouteRecordRaw`), no enrutamiento automatico basado en nombres de archivo (`filenameBasedRouting: false` en `quasar.config.ts`).
- Toda ruta de nivel superior cuelga de un layout en `src/layouts/` (ej. `MainLayout.vue`).
- Las vistas de ruta (`src/pages/`) deben ser delgadas: delegan el contenido real a componentes de `src/components/` cuando la vista concentra logica reutilizable (ver seccion 3).
