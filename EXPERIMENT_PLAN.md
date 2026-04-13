# HiveClaude — Plan de Validación Empírica

> Versión: v0.6 | Inicio: 2026-04-03

Este documento define el plan de experimentos para validar empíricamente las hipótesis
del sistema HiveClaude. Cada sprint prueba una hipótesis específica. Los resultados
se registran en `EXPERIMENT_LOG.md` al finalizar cada sprint.

---

## Hipótesis

| ID | Hipótesis | Sprint que la prueba |
|----|-----------|----------------------|
| H1 | El orquestador delega en workers con las nuevas reglas de protocolo | Sprint 3 |
| H2 | `hive_verify_task` sube el detection rate del reviewer por encima del 37.5% baseline | Sprint 4 |
| H4 | Los algoritmos de coordinación (FEP, Thompson Sampling, CPM) se activan y tienen efecto observable en producción | Sprint 5 |
| H3 | HiveClaude multi-agente produce menos bugs que un agente Claude solo en la misma tarea | Sprint 6 |

**Sprint 3 es bloqueante.** Si H1 falla, los resultados de todos los demás sprints
están contaminados (el orquestador actuaría como agente solo y los otros números
no serían comparables).

---

## Orden de ejecución

```
[Sprint 3] Validación de protocolo
    │
    ├─ H1 confirmada ──► [Sprint 4] Detección con bugs sembrados
    │                        │
    │                        ├─ H2 confirmada ──► [Sprint 5] Coordinación real
    │                        │                        │
    │                        │                        └──► [Sprint 6] Benchmark vs solo
    │                        │
    │                        └─ H2 falsificada ──► Revisar prompt del reviewer
    │                                              (ver sección "Si falla") antes de continuar
    │
    └─ H1 falsificada ──► Restricción de herramientas vía Claude settings.json
                          (ver sección "Si falla") antes de continuar
```

Sprint 5 puede correr en paralelo con Sprint 4 si se dispone de dos sesiones,
ya que prueban variables independientes. En ejecución secuencial: 3 → 4 → 5 → 6.

---

## Pre-condiciones comunes a todos los sprints

Verificar antes de iniciar cualquier sprint:

```bash
# 1. Build limpio
cd hivemind && npm run build

# 2. Tests en verde
cd packages/broker && node --test dist/tests/*.test.js
# Esperado: 321 tests, 0 failures

# 3. Broker no corriendo (evitar conflicto de puertos)
hiveclaude status  # debe decir "not running"

# 4. hive_verify_task registrado
# (se verifica al arrancar el broker — aparece en el log de inicio)
```

---

## Instrumentos de medición

Estas consultas se ejecutan **al finalizar cada sprint** para extraer métricas.

```bash
# Delegation rate — ¿cuántas tareas creó el orquestador vs implementó él mismo?
GET /admin/audit?action=task_created

# Verification rate — ¿cuántas veces usó el reviewer hive_verify_task?
GET /admin/audit?action=verify_task

# Reviews completos
GET /admin/audit?action=task_review

# Intervenciones del FEP
GET /admin/coordinator/interventions

# Historia de κ
GET /admin/health/history

# Snapshot final de todas las tareas
hiveclaude tasks
```

**Definición de métricas:**

| Métrica | Fórmula |
|---------|---------|
| Delegation rate | `hive_create_task calls` / `tareas completadas` |
| Verification rate | `verify_task calls` / `task_review calls` |
| Detection rate | `bugs detectados` / `bugs sembrados` |
| Self-review attempts | entradas `SELF_REVIEW_FORBIDDEN` en audit |
| FEP F medio | `mean(f_before)` de `coordinator_interventions` |

---

---

# Sprint 3 — Validación de protocolo

**Hipótesis:** H1 — El orquestador delega en workers con las nuevas reglas

## Proyecto: QuickAPI

Una REST API mínima en Express. Intencionalmente simple — la tentación de hacerlo
solo es máxima. Si el orquestador delega aquí, lo hará en proyectos más complejos.

**Endpoints:**
- `POST /items` — body: `{ name: string, priority: number }` → devuelve el item creado
- `GET /items` — acepta `?priority=` para filtrar — devuelve `{ items: Item[], count: number }`
- `DELETE /items/:id` — devuelve 204 sin body

Sin base de datos — array en memoria. Incluir tests con `node:test`.

## Agentes

```
orchestrator   → opus
coder-backend  → sonnet
reviewer       → sonnet
```

## Setup

```bash
# Crear e inicializar el proyecto
cd <directorio-de-trabajo>
hiveclaude init sprint3-quickapi
cd sprint3-quickapi
hiveclaude scaffold

# Arrancar broker + todos los agentes en una sola ventana (tabs)
hiveclaude start
hiveclaude exec --launch orchestrator coder-backend reviewer
```

`--launch` abre una sola ventana de Windows Terminal con un tab por agente.
Cada tab arranca en el directorio `agents/<rol>/` con el model correcto.
No usar `hiveclaude run` — lanza todos los 7 roles y contamina el experimento.

Verificar antes de dar el prompt al orquestador:
```bash
hiveclaude status   # broker online
hiveclaude agents   # 0 agentes (ninguno se ha registrado aún)
```

## Prompt al orquestador

```
Necesito una REST API en Express con TypeScript.

Endpoints requeridos:
  POST /items      body: { name: string; priority: number }
                   response: { id: string; name: string; priority: number; createdAt: string }

  GET /items       query: ?priority=number (opcional, filtra exacto)
                   response: { items: Item[]; count: number }

  DELETE /items/:id   response: 204 sin body, 404 si no existe

Sin base de datos — array en memoria es suficiente.
Incluye tests con node:test para los tres endpoints (happy path + error cases).
El servidor debe arrancar con: node dist/server.js
```

## Criterios de éxito / fracaso

| Criterio | Resultado esperado | Cómo verificar |
|----------|-------------------|----------------|
| Orquestador no usa Write/Edit/Bash para código | 0 ocurrencias | audit log |
| ≥2 tareas creadas con hive_create_task | ≥2 en DB | `hiveclaude tasks` |
| Reviewer completa ≥1 review | ≥1 en audit | audit log |
| hive_verify_task llamado ≥1 vez | ≥1 en audit | audit log |
| API funciona: tsc pasa, tests pasan | build verde | manual post-sprint |

**Si H1 falla (orquestador implementa directamente):**

Añadir en `agents/orchestrator/.claude/settings.json`:
```json
{
  "permissions": {
    "deny": ["Write", "Edit", "MultiEdit"]
  }
}
```
Esto fuerza la restricción a nivel de Claude Code, no solo de prompt. Repetir Sprint 3.

---

---

# Sprint 4 — Detección con bugs sembrados

**Hipótesis:** H2 — `hive_verify_task` sube el detection rate por encima del 37.5%

**Prerequisito:** H1 confirmada en Sprint 3.

## Proyecto: MetricsAPI

Una API de métricas con un api-client TypeScript separado. La brecha entre el server
y el client es donde viven los bugs de contrato. El spec al orquestador describe los
contratos con exactitud — los bugs están en que la implementación no cumplirá el spec.

**Nota:** Los bugs no se "siembran" en el código — están sembrados en el spec mismo:
el spec pide cosas que son difíciles de implementar correctamente sin leerlo con cuidado.

## Bugs sembrados en el spec

| ID | Tipo | Dónde | Shape esperado | Error frecuente |
|----|------|-------|----------------|-----------------|
| B1 | API contract | `GET /metrics` | `{ items: Metric[], count: number }` | Devolver array directo sin wrapper |
| B2 | API contract | `GET /metrics/summary` | `{ avg: number; p95: number; p99: number }` | Omitir `p99` |
| B3 | API contract | Todos | `count: number` | Devolver `count: string` (parseInt olvidado) |
| B4 | API contract | `GET /metrics?from=ISO` | param `from` | Implementar como `start` o `since` |
| B5 | TypeScript | api-client | `items` siempre presente | `response.items?.map(...)` sin guard → tsc strict falla |
| B6 | Lógica | `GET /metrics?from=` | filtro `>=` timestamp | Implementar `>` (excluye exacto) |
| B7 | HTTP | `DELETE /metrics/:id` | 204 No Content | Devolver 200 con body |
| B8 | Edge case | `GET /metrics` array vacío | `[]` sin crash | `items[0].value` sin guard |

**Clasificación por detectabilidad:**
- B1, B2, B3, B4 → `hive_verify_task` tipo `http` con shape validation
- B5 → `hive_verify_task` tipo `tsc`
- B8 → `hive_verify_task` tipo `exec` (tests)
- B6, B7 → solo razonamiento del reviewer

## Spec al orquestador (acceptance_criteria de cada tarea)

El orquestador recibe esto como parte del prompt:

```
API server — acceptance_criteria:
  GET /metrics
    response shape: { items: Metric[], count: number }
    Metric: { id: string; value: number; timestamp: string; label: string }
    query params: ?from=ISO8601 (filtra items con timestamp >= from)
    edge case: array vacío → { items: [], count: 0 } sin crash

  GET /metrics/summary
    response shape: { avg: number; p95: number; p99: number }
    calcula sobre todos los items actuales

  POST /metrics
    body: { value: number; label: string }
    response: Metric (con id generado y timestamp)

  DELETE /metrics/:id
    response: 204 No Content
    404 si el id no existe

API client TypeScript — acceptance_criteria:
  Tipos explícitos para todos los response shapes (no any)
  Compila con tsc --strict sin errores
  Exporta: getMetrics(), getSummary(), postMetric(), deleteMetric()
```

## Agentes

```
orchestrator   → opus
coder-backend  → sonnet   (implementa server + client)
reviewer       → sonnet
```

## Criterios de éxito

| Métrica | Umbral mínimo | Umbral objetivo |
|---------|---------------|-----------------|
| Detection rate total (B1-B8) | >37.5% (>3/8) | ≥75% (≥6/8) |
| Detection rate API contract (B1-B4) | ≥2/4 (50%) | ≥3/4 (75%) |
| B1, B2, B3 detectados (shape BFS) | 2/3 | 3/3 |
| hive_verify_task usado por reviewer | ≥1 vez | ≥1 vez por review |

**Si H2 falla (detection rate ≤ 37.5%):**

Opciones a evaluar:
1. El reviewer no llamó `hive_verify_task` → hacer la call obligatoria (añadir validación
   en `getPendingReviewsTool` que inyecte un recordatorio si la tarea tiene http criteria)
2. El reviewer llamó `hive_verify_task` pero los checks no capturaron los bugs →
   revisar el BFS shape validator (puede haber un gap en la implementación)
3. El spec no era suficientemente explícito → mejorar el formato de acceptance_criteria

## Registro post-sprint

```markdown
### Sprint 4 — Bugs detectados

| Bug | Detectado | Método | Evidencia |
|-----|-----------|--------|-----------|
| B1 — wrapper shape | sí/no | verify_task http / razonamiento / no detectado | ... |
| B2 — p99 faltante  | sí/no | ... | ... |
| B3 — count: string | sí/no | ... | ... |
| B4 — param name    | sí/no | ... | ... |
| B5 — tsc strict    | sí/no | ... | ... |
| B6 — filtro >=     | sí/no | ... | ... |
| B7 — 204 vs 200    | sí/no | ... | ... |
| B8 — empty array   | sí/no | ... | ... |

Detection rate: N/8 = X%
Baseline Sprint 1: 3/8 = 37.5%
Delta: +/- X%
```

---

---

# Sprint 5 — Coordinación multi-agente + bugs de integración real

**Hipótesis:** H4 — Los algoritmos de coordinación se activan en producción con 4 agentes.
**Hipótesis secundaria (rediseñada desde Sprint 4):** Los bugs de integración entre dos
agentes que trabajan en paralelo emergen en la zona de contacto y son detectables por
el reviewer con `hive_verify_task`.

**Prerequisito:** H1 confirmada (Sprint 3 ✓).

## Por qué este diseño

Sprint 4 demostró que bugs de contrato no emergen con specs explícitos en un solo sistema.
Los bugs reales de integración ocurren en la **zona de contacto** entre dos sistemas
implementados por agentes distintos sin comunicación directa entre sí.

El coder-backend implementa su spec. El coder-frontend implementa el suyo. Cada uno es
correcto individualmente. Los bugs emergen de lo que el spec no especificó en la
intersección: nombres de campo, tipos de valores, campos opcionales vs requeridos.
Nadie cometió un error — cada agente completó su tarea con información parcial del otro.

## Proyecto: StatusBoard

Express backend + React frontend. Los dos coders trabajan en paralelo sin comunicarse.
El reviewer valida la integración cuando ambos terminan — ese es el nodo crítico.

### Contratos del backend (T1 — coder-backend)

```
GET /api/status
  response: {
    services: Array<{
      id: string;
      name: string;
      status: "up" | "down" | "degraded";
      latency: number;        // milliseconds
      region: string;
    }>;
    healthy: boolean;         // true si TODOS tienen status "up"
    checkedAt: string;        // ISO timestamp
  }

GET /api/incidents
  response: {
    incidents: Array<{
      id: string;
      title: string;
      severity: "low" | "medium" | "high" | "critical";
      affectedService: string;  // nombre del servicio (string, no id)
      createdAt: string;
      resolvedAt: string | null;
    }>;
    total: number;
    open: number;             // cuántos tienen resolvedAt === null
  }

Incluir al menos 3 services y 2 incidents en memoria (hardcoded está bien).
Puerto: 4000. Compilar con tsc --strict.
```

### Spec del frontend (T2 — coder-frontend)

El coder-frontend recibe solo esto — sin los tipos del backend:

```
Componentes React + TypeScript:
  ServiceCard({ service })   — muestra nombre, estado (badge color), latency ms, region
  IncidentRow({ incident })  — muestra title, severidad badge, servicio afectado, fecha, abierto/resuelto
  StatusPage                 — llama GET /api/status y GET /api/incidents al montar,
                               renderiza ServiceCard por cada service e IncidentRow por cada incident.
                               Si el sistema no está saludable → banner rojo "System Degraded"

El frontend llama http://localhost:4000. Define sus propios tipos TypeScript localmente.
No importa tipos del backend. Compilar con tsc --strict (Vite).
```

**La zona de integración (no especificada al frontend):**
El spec del frontend describe comportamiento pero no shapes exactos. El frontend
inferirá los nombres de campo. Las divergencias más probables:
- `service.status` → frontend usa `service.state` o `service.health`
- `incident.affectedService` → frontend usa `incident.service` o `incident.serviceId`
- `incident.open` (calculado por backend) → frontend calcula localmente desde `resolvedAt`
- `response.total` → frontend usa `response.count`

## DAG de tareas

```
[T1] coder-backend   → API server completo (ambos endpoints + datos hardcoded)
[T2] coder-frontend  → Componentes + StatusPage (paralelo con T1)
                       ↓ ambos en qa_pending
[T3] reviewer        → QA integración: verifica que frontend consume campos reales del backend
                       Si frontend usa campos incorrectos → RECHAZA con hive_verify_task evidence
                       ↓ si rechaza
[T4] coder-frontend  → Fix de campos incorrectos (depende de T3)
                       ↓
[T5] reviewer        → QA final
```

T1 y T2 en paralelo. T3 no puede empezar hasta T1 **y** T2 en qa_pending.
Esta dependencia multi-source es la que valida `hive_add_dependency` en producción.

## Agentes

```
orchestrator    → opus
coder-backend   → sonnet
coder-frontend  → sonnet
reviewer        → sonnet
```

## Setup

```bash
cd "C:/Users/justi/OneDrive/Desktop/Desktop/Sistemas/MCP/Code"
mkdir sprint5-statusboard
cd sprint5-statusboard
hiveclaude init sprint5-statusboard
hiveclaude scaffold
hiveclaude run --roles orchestrator coder-backend coder-frontend reviewer --yolo
```

## Prompt al orquestador

```
Necesito una app fullstack de status dashboard. Dos partes que deben implementarse
en paralelo por dos agentes distintos.

── PARTE 1 (coder-backend): API Express + TypeScript ────────

GET /api/status
  response: {
    services: Array<{
      id: string; name: string; status: "up"|"down"|"degraded";
      latency: number; region: string;
    }>;
    healthy: boolean;   // true si TODOS los services tienen status "up"
    checkedAt: string;  // ISO timestamp
  }

GET /api/incidents
  response: {
    incidents: Array<{
      id: string; title: string;
      severity: "low"|"medium"|"high"|"critical";
      affectedService: string;
      createdAt: string; resolvedAt: string | null;
    }>;
    total: number;
    open: number;  // count de incidents con resolvedAt === null
  }

Datos en memoria hardcodeados (mínimo 3 services, 2 incidents).
Puerto 4000. tsc --strict.

── PARTE 2 (coder-frontend): React + TypeScript (Vite) ──────

Componentes:
  ServiceCard — nombre, status badge (verde=up, rojo=down, amarillo=degraded), latency ms, region
  IncidentRow — title, severity badge, servicio afectado, fecha creación, estado open/resolved
  StatusPage  — fetch a GET /api/status y GET /api/incidents, renderiza ambas listas.
                Si healthy === false → banner rojo "System Degraded"

El frontend llama a http://localhost:4000.
Define sus propios tipos TypeScript localmente (no importa del backend).
tsc --strict.

── INSTRUCCIÓN CRÍTICA ──────────────────────────────────────

Crea T1 (backend) y T2 (frontend) como tareas PARALELAS — ambas deben empezar
al mismo tiempo. Crea T3 (reviewer) que depende de AMBAS T1 y T2.
Usa hive_add_dependency para añadir la dependencia T3→T2 después de crear las tareas.

Por favor planifica antes de crear tareas.
```

## Métricas a recolectar

### Coordinación (H4)

| Métrica | Cómo medir | Qué valida |
|---------|------------|------------|
| T1 y T2 solapadas en tiempo | timestamps claimed_at en audit log | Paralelismo real |
| T3 no empieza hasta T1+T2 qa_pending | timestamps en audit | DAG multi-dependencia |
| `hive_add_dependency` llamado | audit log | Orquestador usa la tool |
| F durante el sprint | GET /admin/coordinator (manual) | FEP activo |
| Intervenciones registradas | /admin/coordinator/interventions | Learning loop activo |
| κ evolution | /admin/health/history | Criticality Engine activo |

### Integración (H2 rediseñada)

| Métrica | Qué mide |
|---------|---------|
| Reviewer llamó hive_verify_task | Regla 5 funciona |
| hive_verify_task detectó campo incorrecto | BFS shape search en producción real |
| Ciclos review/fix hasta aprobar | Costo real del bucle de integración |
| Nº campos incorrectos en primera iteración del frontend | Probabilidad base del error de integración |

## Criterios de éxito

| Criterio | Umbral | Fallo indica |
|----------|--------|--------------|
| T1 y T2 solapadas en tiempo | Deseable | Agentes no corrieron en paralelo |
| T3 no empieza antes de T1+T2 | **Estricto** | Bug en DAG multi-dependencia |
| Reviewer llama hive_verify_task | **Estricto** | Regla 5 insuficiente, necesita enforcement en broker |
| ≥1 campo incorrecto en frontend (primera iteración) | Esperado | Hipótesis de integración confirmada |
| hive_verify_task detecta el campo incorrecto | Objetivo | BFS shape search funciona en producción |
| Sprint completa sin intervención humana | Deseable | Protocolo autónomo |

## Interpretación de resultados

| Escenario | Conclusión |
|-----------|-----------|
| Reviewer usa verify_task + detecta campo incorrecto | **H4 confirmada.** 4 agentes coordinados en producción, DAG funciona, QA con verificación activa. |
| Reviewer usa verify_task pero frontend implementó correcto | Bugs de integración no son probabilísticos con spec intermedio — rediseñar Sprint 6 con spec deliberadamente ambiguo. |
| Reviewer no usa verify_task | Regla 5 del prompt insuficiente. Añadir middleware en `getPendingReviews` que rechace si no hay verify_task en el audit para esa tarea. |
| T1 y T2 no solapan | Los agentes no procesan en paralelo. Investigar si coder-frontend esperó innecesariamente o si el broker no envió task_available a tiempo. |
| T3 empieza antes de T1+T2 | Bug en DAG multi-dependencia — fix urgente antes de Sprint 6. |

---

---

# Sprint 6 — Integración real con ambigüedad deliberada + Benchmark

**Dos objetivos en un sprint:**

1. **Validar el fix del reviewer** — confirmar que con la corrección del prompt del
   orquestador, el reviewer (no el coder) es quien hace la QA de integración.

2. **Benchmark H3** — misma tarea corrida por HiveClaude y por Claude solo, con juez
   ciego evaluando calidad. Este es el dato central del proyecto.

**Prerequisito:** Sprint 5 completado. Fix aplicado al orchestrator.md (no crear tareas
QA con rol de worker).

---

# Sprint 6A — Validación del fix: reviewer como punto de integración

**Hipótesis:** H2 revalidada + confirmar fix del reviewer

## Proyecto: EventsAPI

API de eventos + cliente TypeScript. Backend y frontend implementados en paralelo.
Los campos del backend usan nombres no convencionales deliberadamente para forzar
divergencia en el frontend.

### Contratos del backend (spec exacto para coder-backend)

```
GET /api/events
  response: {
    payload: Event[];          ← no "items", no "events" — "payload"
    cursor: string | null;     ← paginación, no "nextPage" ni "offset"
    exhausted: boolean;        ← no "hasMore" — "exhausted" (true si no hay más)
  }
  Event: {
    eid: string;               ← no "id" — "eid"
    label: string;             ← no "title" ni "name" — "label"
    kind: "info"|"warn"|"error"|"fatal";   ← no "type" ni "severity" — "kind"
    emittedAt: string;         ← no "createdAt" ni "timestamp" — "emittedAt"
    src: string;               ← no "source" ni "origin" — "src"
    ack: boolean;              ← no "read" ni "seen" — "ack"
  }

POST /api/events/ack/:eid
  response: 200 con { eid: string; ack: true }
  404 si el eid no existe
```

### Spec del frontend (deliberadamente vago en nombres de campo)

```
Componentes React:
  EventRow — muestra el label del evento, su tipo/severidad, origen, fecha y si fue leído
  EventList — lista todos los eventos, botón "mark as read" por evento
  EventsPage — llama GET /api/events al montar, renderiza EventList.
               Si hay eventos de tipo "fatal" sin leer → banner rojo "Critical Events Pending"

El frontend llama http://localhost:4000.
Define sus propios tipos localmente. No importa del backend.
```

**Campos trampa:** `payload` (no `events`), `eid` (no `id`), `kind` (no `type`), `emittedAt` (no `timestamp`), `ack` (no `read`), `exhausted` (no `hasMore`). Al menos 3-4 divergirán.

## DAG de tareas (instrucción crítica para el orquestador)

```
[T1] coder-backend   → API server (todos los endpoints)     rol: coder-backend
[T2] coder-frontend  → Componentes + EventsPage             rol: coder-frontend
     (paralelo con T1)
     — ambas en qa_pending →
[T3] reviewer        → QA integración (depende T1 + T2)     SIN assigned_role
                       verifica con hive_verify_task que frontend
                       usa los campos correctos del backend
```

## Setup

```bash
cd "C:/Users/justi/OneDrive/Desktop/Desktop/Sistemas/MCP/Code"
mkdir sprint6a-eventsapi
cd sprint6a-eventsapi
hiveclaude init sprint6a-eventsapi
hiveclaude scaffold
hiveclaude run --roles orchestrator coder-backend coder-frontend reviewer --yolo
```

## Prompt al orquestador

```
Necesito una app de event log con backend y frontend en paralelo.

── PARTE 1 (coder-backend): API Express + TypeScript ────────

GET /api/events
  response: {
    payload: Event[];
    cursor: string | null;
    exhausted: boolean;
  }
  Event: {
    eid: string;
    label: string;
    kind: "info" | "warn" | "error" | "fatal";
    emittedAt: string;
    src: string;
    ack: boolean;
  }

POST /api/events/ack/:eid
  response: 200 con { eid: string; ack: true }
  404 si eid no existe

Datos hardcodeados en memoria (5+ eventos variados, algunos con ack:false).
Puerto 4000. tsc --strict.

── PARTE 2 (coder-frontend): React + TypeScript (Vite) ──────

Componentes:
  EventRow — muestra label, tipo/severidad, origen, fecha, estado leído/no-leído,
             botón "Ack" que llama POST /api/events/ack/:id
  EventList — lista todos los eventos usando EventRow
  EventsPage — llama GET /api/events al montar, renderiza EventList.
               Si hay eventos fatales sin leer → banner rojo "Critical Events Pending"

Frontend en http://localhost:4000. Tipos TypeScript locales. tsc --strict.

── INSTRUCCIÓN CRÍTICA ──────────────────────────────────────

Crea T1 (backend) y T2 (frontend) en PARALELO.
Crea T3 de QA de integración que depende de T1 Y T2 — pero SIN assigned_role.
El reviewer la tomará automáticamente via su pipeline QA.
NO asignes T3 a ningún rol de coder.

Por favor planifica antes de crear tareas.
```

## Criterios de éxito

| Criterio | Umbral | Qué confirma |
|----------|--------|--------------|
| T3 tomada por reviewer-1 (no coder) | **Estricto** | Fix del prompt funciona |
| Reviewer llama hive_verify_task en T3 | **Estricto** | Regla 5 activa con reviewer real |
| Frontend usa ≥2 campos incorrectos | Esperado | Ambigüedad deliberada funciona |
| hive_verify_task detecta divergencia | Objetivo | BFS shape search en producción |
| Reviewer rechaza con evidencia específica | Objetivo | QA real con datos concretos |

---

# Sprint 6B — Benchmark: HiveClaude vs Claude solo

**Hipótesis:** H3 — Multi-agente produce menos bugs que un agente solo

**Prerequisito:** Sprint 6A completado (reviewer tomando T3 correctamente).

## Proyecto: NotesAPI

Una API de notas con CRUD completo + api-client TypeScript. Misma tarea para ambas
ejecuciones. Suficientemente compleja para que los bugs emerjan naturalmente.

**Endpoints:**
- `POST /notes` → `{ id, title, content, tags: string[], createdAt }`
- `GET /notes` → `{ notes: Note[], count: number }` con `?tag=` y `?search=`
- `GET /notes/:id` → `Note` o 404
- `PUT /notes/:id` → actualiza, devuelve Note actualizado o 404
- `DELETE /notes/:id` → 204 o 404

**api-client TypeScript:**
- Tipos estrictos para todos los shapes
- Exporta función por endpoint
- Compila con `tsc --strict`

## Ejecución A — HiveClaude

```
orchestrator + coder-backend + reviewer
Sin tiempo límite — hasta sprint_complete
```

## Ejecución B — Claude solo

```
Un solo Claude Code (sonnet) en el directorio del proyecto
Prompt idéntico al del orquestador (sin el protocolo de coordinación)
Sin pipeline QA
```

## Checklist del juez (evaluación ciega post-sprint)

Un Claude con el siguiente prompt evalúa ambas implementaciones sin saber cuál es cuál:

```
Eres un revisor técnico evaluando una implementación de API.
Evalúa cada criterio como PASS o FAIL con una línea de justificación.
NO expliques cuál es mejor — solo evalúa cada criterio independientemente.
```

| # | Criterio | Tipo |
|---|---------|------|
| C1 | `GET /notes` devuelve `{ notes: Note[], count: number }` (no array directo) | Contract |
| C2 | `GET /notes?search=` filtra por título O contenido (no solo título) | Lógica |
| C3 | `GET /notes?tag=` filtra correctamente | Lógica |
| C4 | `PUT /notes/:id` es idempotente (dos llamadas = mismo resultado) | Lógica |
| C5 | `DELETE /notes/:id` devuelve 404 para id inexistente | HTTP |
| C6 | `GET /notes/:id` devuelve 404 para id inexistente | HTTP |
| C7 | api-client compila con `tsc --strict` sin errores | TypeScript |
| C8 | api-client usa tipos explícitos (no `any`) | TypeScript |
| C9 | Hay tests que cubren happy path (≥3 endpoints) | Tests |
| C10 | Hay tests que cubren al menos 1 caso de error | Tests |

## Métricas finales

| Métrica | Ejecución A | Ejecución B | Delta |
|---------|-------------|-------------|-------|
| Criterios cumplidos (0-10) | ? | ? | ? |
| Tokens consumidos (estimado) | ? | ? | ? |
| Bugs detectados antes de entrega | ? (reviewer) | 0 | — |
| Tiempo hasta implementación lista | ? | ? | ? |

## Interpretación de resultados

| Resultado | Conclusión |
|-----------|-----------|
| A > B en criterios | Multi-agente mejora calidad. Costo adicional justificado si delta > 2 criterios. |
| A = B en criterios | HiveClaude no añade valor en tareas simples. El overhead no vale la pena para proyectos pequeños. |
| B > A en criterios | El overhead de coordinación perjudica. El orquestador no delegó correctamente o el reviewer rechazó sin razón. |
| A > B pero A usa 3x tokens | Multi-agente tiene un umbral de rentabilidad — sólo vale para proyectos donde 2-3 bugs en producción cuestan más que los tokens. |

Cualquiera de los cuatro resultados es un hallazgo publicable.

---

---

## EXPERIMENT_LOG — Resultados

> Completar tras cada sprint. No editar resultados pasados.

### Sprint 3 — 2026-04-03
**Proyecto:** QuickAPI (REST API Express + TypeScript, 3 endpoints, tests node:test)
**Agentes:** orchestrator (opus) + coder-backend (sonnet) + reviewer (sonnet)
**Estado:** COMPLETADO

```
Delegation rate:      100% — orquestador usó hive_create_task, nunca Write/Edit/Bash
Tareas creadas:       2 (API implementation + tests, con DAG correcto)
DAG funcionó:         ✓ — tarea 2 bloqueada hasta QA de tarea 1
Verification rate:    0% — reviewer NO llamó hive_verify_task
Self-review attempts: 0 — SELF_REVIEW_FORBIDDEN no fue necesario activarse
H1: CONFIRMADA
```

**Resultado de la API:**
- POST /items → 201, shape correcto ✓
- GET /items → { items: [], count: N } ✓
- GET /items?priority= → filtra correctamente ✓
- DELETE /items/:id existente → 204 ✓
- DELETE /items/:id inexistente → 404 ✓

**Bug que pasó QA sin detectar:**
Los tests de node:test fallaban en ejecución (`ERR_MODULE_NOT_FOUND` — tsconfig
rootDir:src excluía tests/ de la compilación). El reviewer aprobó los tests sin
ejecutarlos. hive_verify_task con tipo `exec` habría detectado esto inmediatamente.

**Observaciones:**
El orquestador cumplió el protocolo correctamente. El problema de delegación
(Sprint 2) está resuelto. El gap restante es el reviewer: las nuevas reglas absolutas
del prompt (Regla 5: hive_verify_task obligatorio) no estaban activas en este sprint
— se añadieron después como corrección. Sprint 4 medirá si el prompt actualizado
tiene efecto.

---

### Sprint 4 — 2026-04-03
**Proyecto:** MetricsAPI (API server + TypeScript client, 4 endpoints, bugs sembrados en spec)
**Agentes:** orchestrator (opus) + coder-backend (sonnet) + reviewer (sonnet)
**Estado:** COMPLETADO — hallazgo inesperado

```
Detection rate: 0/8 = 0% — ningún bug emergió
Baseline:       3/8 = 37.5%
Delta:          N/A (no había bugs que detectar)

Por bug:
  B1 (wrapper shape):  NO EMERGIÓ — spec explícito, coder implementó { items, count }
  B2 (p99 faltante):   NO EMERGIÓ — spec listaba los 3 campos, coder los implementó
  B3 (count string):   NO EMERGIÓ — count: items.length es number naturalmente
  B4 (param name):     NO EMERGIÓ — spec decía "from", coder usó "from"
  B5 (tsc strict):     NO EMERGIÓ — compiló limpio
  B6 (filtro >=):      NO EMERGIÓ — spec decía ">=", coder usó >=
  B7 (204 vs 200):     NO EMERGIÓ — spec decía "204 sin body", coder devolvió 204
  B8 (empty array):    NO EMERGIÓ — coder añadió guard explícito

hive_verify_task usado: desconocido (broker offline al medir) — broker logs no disponibles
H2: INCONCLUSA — experimento inválido, necesita rediseño
```

**Hallazgo principal (no anticipado):**
Un spec con shapes exactos y status codes explícitos elimina los bugs antes de que
existan. Los bugs de Sprint 1 (hive-lens, 37.5% detection) emergieron porque el spec
era vago ("el frontend muestra los datos de salud"). Con acceptance_criteria precisos,
el coder no tiene ambigüedad donde introducir error.

**Conclusión científica:**
La calidad del spec es más determinante que la calidad del QA para la categoría de
bugs de contrato API. Esto redefine el diseño de Sprint 5: los bugs de integración
deben emerger de la brecha entre dos implementaciones independientes con specs
correctos pero incompletos en su intersección.

**Observaciones:**
Sprint 5 se rediseña para bugs de integración real: coder-backend y coder-frontend
implementan sus specs de forma independiente. Los bugs emergen de la zona de contacto
entre ambos — donde el backend implementa el contrato correcto y el frontend asume
algo ligeramente diferente. Este tipo de error no se puede prevenir con spec explícito
de un solo sistema.

---

### Sprint 5 — 2026-04-03
**Proyecto:** StatusBoard (Express backend + React frontend, 4 agentes simultáneos)
**Agentes:** orchestrator (opus) + coder-backend (sonnet) + coder-frontend (sonnet) + reviewer (sonnet)
**Estado:** COMPLETADO — H4 parcialmente confirmada, nuevo gap descubierto

```
T1‖T2 paralelas:          ✓ — coder-backend y coder-frontend tomaron tareas simultáneamente
DAG multi-dependencia:    ✓ — T3 esperó a T1 Y T2 antes de desbloquearse
hive_verify_task llamado: ✓ — 3 veces (5/5, 8/8, 6/6 checks pasados)
Reviewer usó verify_task: ✗ — lo llamó coder-backend-1, no reviewer-1
T3 asignada correctamente:✗ — coder-backend tomó T3 (rol coder-backend en tarea QA)
Self-review intento:      0 — SELF_REVIEW_FORBIDDEN no se activó
F máximo:                 no medido (broker offline al intentar)
Intervenciones FEP:       no medidas
Lock contentions:         0
H4: PARCIALMENTE CONFIRMADA
```

**Bugs de integración frontend:**
El frontend implementó tipos exactos del backend — cero divergencia en nombres de campo.
`affectedService`, `resolvedAt`, `open`, `total`, `healthy`, `checkedAt` — todos correctos.
Hipótesis falsificada: los LLMs conocen convenciones REST estándar y no cometen errores
de integración en campos con nombres semánticamente claros.

**Gap descubierto — asignación de rol en tareas QA:**
El orquestador creó T3 con `assigned_role: coder-backend` en lugar de dejarlo sin rol
para que el reviewer lo tome via `hive_get_pending_reviews`. El coder hizo su propia QA,
la pasó sin problemas, y el reviewer aprobó sin inspección real.
`hive_verify_task` fue llamado por el coder (como self-verification), no por el reviewer.

**Observaciones:**
DAG, paralelismo y verify_task funcionan a nivel de infraestructura. El problema es
de prompt del orquestador: no tiene instrucción explícita de que las tareas de QA
no deben tener `assigned_role`. Corrección aplicada en Sprint 6: añadir al prompt
que las tareas de integración/QA se dejan sin rol asignado.

La hipótesis de bugs de integración por ambigüedad requiere spec deliberadamente vago
en los nombres de campo. Con nombres naturales (affectedService, resolvedAt) los LLMs
aciertan. Sprint 6 usará nombres de campo no convencionales para forzar divergencia.

---

### Sprint 6A — [fecha]
**Proyecto:** EventsAPI (campos no convencionales para forzar divergencia frontend)
**Agentes:** orchestrator + coder-backend + coder-frontend + reviewer
**Estado:** PENDIENTE

```
T3 tomada por reviewer (no coder): —
Reviewer llamó hive_verify_task:   —
Campos incorrectos en frontend:    —/6 campos trampa
hive_verify_task detectó divergencia: —
Reviewer rechazó con evidencia:    —
H2 revalidada: PENDIENTE
Fix del reviewer: PENDIENTE
```

**Observaciones:**

---

### Sprint 6B — [fecha]
**Proyecto:** NotesAPI (benchmark HiveClaude vs Claude solo)
**Agentes A:** orchestrator + coder-backend + coder-frontend + reviewer
**Agentes B:** Claude solo (sonnet)
**Estado:** PENDIENTE

```
Criterios A (HiveClaude): —/10
Criterios B (Claude solo): —/10
Delta:   —

Bugs detectados antes de entrega A: — (por reviewer)
Bugs detectados antes de entrega B: 0 (sin QA)

H3: PENDIENTE
```

**Observaciones:**
