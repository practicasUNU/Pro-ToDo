# Reglas y Estándares de Pruebas (Testing Standards)

## 1. 🧪 Estructura de Pruebas: Patrón AAA (Arrange-Act-Assert)
Todas las pruebas unitarias e integración en Jest deben estructurarse explícitamente en tres bloques:
- 📐 **Arrange (Preparar):** Configurar el estado inicial, instanciar dobles de prueba (*mocks*) y preparar el `StatePayloadContext`.
- ⚙️ **Act (Actuar):** Ejecutar el método bajo prueba (ej. `strategy.execute()`).
- 🎯 **Assert (Verificar):** Validar el resultado devuelto (`NodeResult`), el estado de error y las llamadas a los *spies*.

```typescript
describe('LlmExtractorStrategy', () => {
  it('should extract structured JSON successfully from valid email body', async () => {
    // 1. Arrange 📐
    const mockAnthropicService = {
      createMessage: jest.fn().mockResolvedValue({
        title: 'Innovación en Madrid',
        summary: 'Resumen estructurado...',
      }),
    };
    const strategy = new LlmExtractorStrategy(mockAnthropicService as any);
    const context = new StatePayloadContext('exec-123', 'PROCESADOR_IA');
    context.setNamespace('nodo_trigger', {
      body: 'Texto del correo sobre innovación...',
    });

    // 2. Act ⚙️
    const result = await strategy.execute(context, { promptKey: 'extract_news' });

    // 3. Assert 🎯
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data?.title).toBe('Innovación en Madrid');
    expect(mockAnthropicService.createMessage).toHaveBeenCalledTimes(1);
  });
});

```

---

## 2. 🎭 Dobles de Prueba y Aislamiento (Mocks / Spies)

* 🚫 **Cero llamadas reales a servicios externos:** Prohibido realizar llamadas reales por red a IMAP, Claude/ChatGPT, Drupal o Acens durante las pruebas unitarias.


* 🛡️ **Simulación de Clientes HTTP / SDKs:** Usar `jest.spyOn()` o mocks inyectados de Jest para simular respuestas exitosas, respuestas malformadas y errores de red.



---

## 3. 💥 Pruebas Negativas y Casos Límite (Edge Cases)

Cada estrategia y servicio debe contar obligatoriamente con pruebas negativas que fuercen fallos controlados:

* **Datos incompletos:** Entradas sin texto, payloads nulos o campos obligatorios faltantes.


* **Errores de proveedor:** Simulación de códigos HTTP `429 Too Many Requests` (límites de cuota) o `503 Service Unavailable`.


* **Validación esperada:** Verificar que retorne `success: false` con la categorización de error adecuada (`LEVE`, `GRAVE`, `URGENTE`) sin provocar excepciones no capturadas.



```typescript
it('should return GRAVE error when mandatory fields are missing', async () => {
  // Arrange 📐
  const strategy = new TemplateMapperStrategy();
  const context = new StatePayloadContext('exec-124', 'MAPEADOR_PLANTILLA');
  // Contexto sin la clave "titulo" esperada

  // Act ⚙️
  const result = await strategy.execute(context, {
    templateId: 'tpl-1',
    variableMapping: { title: 'nodo_sanitizado.titulo' },
  });

  // Assert 🎯
  expect(result.success).toBe(false);
  expect(result.error?.level).toBe('GRAVE');
  expect(result.error?.missingFields).toContain('nodo_sanitizado.titulo');
});

```

---

## 4. ⚡ Pruebas de Concurrencia y Aislamiento de Contexto

* **Aislamiento de memoria:** Verificar que múltiples instancias de `StatePayloadContext` ejecutándose en paralelo no compartan ni muten los *namespaces* entre sí.


* **Simulación de flujos simultáneos:** Ejecutar múltiples promesas concurrentes (`Promise.all()`) para comprobar la estabilidad del motor `FsmEngineService` bajo carga.
