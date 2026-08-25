# Reglas de Arquitectura Frontend (Vue 3 / Quasar)

## 1. 🌐 Capa de Servicios (`src/services/`)

- **Ubicación obligatoria de las llamadas HTTP:** Toda petición a la API del backend (usando Axios, vía `@boot/axios`) debe residir exclusivamente en archivos dentro de `src/services/` (ej. `users.service.ts`).
- **Prohibiciones estrictas:**
  - ❌ Llamadas HTTP directas (`api.get`, `api.post`, etc.) dentro de componentes `.vue`.
  - ❌ Llamadas HTTP directas dentro de stores de Pinia (`src/stores/`).
- **Convención de archivo:** un servicio por entidad/dominio (`users.service.ts`, `flujos.service.ts`), exportando funciones puras que reciben parámetros tipados y retornan la data ya parseada (`response.data`), nunca la respuesta cruda de Axios.

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

## 3. 🧩 Patron de Reusabilidad: Layouts vs Componentes

- **Abstraccion en Layouts (`src/layouts/`):** cuando una estructura visual general (menus laterales, cabeceras, `q-drawer`, `q-header`) envuelve multiples vistas que solo cambian en su contenido central (`router-view`). Un layout se referencia desde `src/router/routes.ts` como componente padre de un grupo de rutas.
- **Abstraccion en Componentes (`src/components/`):** cuando un bloque de interfaz especifico (tablas custom, modales, tarjetas) se repite en el sistema o concentra logica interna que muta segun props (ej. `SafeDeleteModal.vue`, `UserDialog.vue`). Se organiza por dominio (`src/components/users/`, `src/components/flujos/`).
- **Regla de decision rapida:** si el elemento envuelve rutas → Layout. Si el elemento vive dentro de una ruta y se repite o tiene logica propia → Componente.

---

## 4. 📁 Estructura de Enrutamiento

- El enrutador usa `src/router/routes.ts` (arreglo explicito de `RouteRecordRaw`), no enrutamiento automatico basado en nombres de archivo (`filenameBasedRouting: false` en `quasar.config.ts`).
- Toda ruta de nivel superior cuelga de un layout en `src/layouts/` (ej. `MainLayout.vue`).
- Las vistas de ruta (`src/pages/`) deben ser delgadas: delegan el contenido real a componentes de `src/components/` cuando la vista concentra logica reutilizable (ver seccion 3).
