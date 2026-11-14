# BMAD Dashboard

Dashboard (NestJS) que convierte el estado de tu proyecto **BMAD Method** en información visual:
épicas, historias, progreso de tareas, alertas de consistencia, **comandos sugeridos** para continuar,
un **generador de especificaciones** de historias y el **historial del sprint** guardado en Supabase.

## Cómo funciona

| Modo | Cuándo | Qué hace |
|---|---|---|
| **Carpeta del navegador** | Web publicada (Vercel) y local | Eliges la carpeta del proyecto. El navegador la lee (File System Access API) y envía **solo** los archivos BMAD (historias, épicas, `sprint-status.yaml`, config) a la API para analizarlos. En Chrome/Edge las historias nuevas se escriben directamente en tu carpeta. En Firefox/Safari se usa un selector de solo lectura y las historias se descargan. |
| **Ruta local** | Solo al ejecutar la app en tu equipo | Escribes o exploras la ruta; el servidor lee el disco. Deshabilitado en Vercel. |
| **Nube (Supabase)** | Con sesión iniciada | Cada vez que cambia el estado se guarda un snapshot: tendencia del sprint, último estado visible desde cualquier dispositivo (solo lectura) y especificaciones guardadas. |

## Actualización en vivo

El dashboard se actualiza solo cuando cambian las historias (activado por defecto, interruptor **En vivo** en la barra superior):

| Fuente | Cómo detecta cambios |
|---|---|
| Carpeta (Chrome/Edge recientes) | `FileSystemObserver`: al instante |
| Carpeta (otros navegadores con File System Access) | Revisa fechas/tamaños de los archivos BMAD cada 4 s y solo relee los que cambiaron |
| Ruta local | `GET /api/local/signature` cada 3 s; recalcula solo si la firma cambia |
| Vista en la nube | Supabase Realtime sobre `snapshots`: se actualiza cuando otro dispositivo sincroniza |

Al detectar cambios muestra un aviso (p. ej. `1.3: En progreso → En revisión`), resalta las historias afectadas,
añade la entrada al panel **Cambios detectados**, recalcula los comandos sugeridos y sincroniza el snapshot.

## Asistente con IA (Groq gratis o Claude)

Pestaña **✨ Asistente** y botones ✨ en el dashboard. Cada usuario usa **su propia API key**: se guarda solo en su navegador
y el servidor la reenvía al proveedor en cada petición sin almacenarla ni registrarla.

| Proveedor | Coste | Modelos | Notas |
|---|---|---|---|
| **Groq** (por defecto) | Plan gratuito sin tarjeta | Los de tu cuenta (p. ej. `openai/gpt-oss-120b`, `openai/gpt-oss-20b`) | Límites por minuto/día. El contexto se compacta (~5K tokens máx.) y los documentos se envían como extracto. Key en console.groq.com/keys |
| **Claude** | Créditos prepagados de la API de Anthropic | Sonnet 5.5, Opus 5.5, Haiku 5.5 | Contexto completo con prompt caching. Key en console.anthropic.com/settings/keys |

- **Chat sobre el proyecto**: conoce épicas, historias, alertas y comandos sugeridos (en el formato elegido); opcionalmente PRD, arquitectura, UX y épicas.
- **Preguntar sobre una historia** desde su detalle, con su markdown en contexto.
- **✨ Redactar con IA** y **✨ Revisar con IA** en Nueva historia.
- **Contexto eficiente en tokens**: en lugar de enviar el PRD y la arquitectura completos en cada mensaje, el navegador divide los documentos
  por encabezados y elige con BM25 solo las secciones relevantes para la pregunta, la historia en foco o la historia que se redacta
  (modo **Auto**; también **Siempre** y **Nunca**). Las preguntas generales no llevan documentos. Usa los fragmentos de `shard-doc`
  si existen, y envía siempre `project-context.md` y `devLoadAlwaysFiles`. Cada respuesta muestra qué fuentes se usaron.
  El prompt va ordenado de lo estable a lo variable (instrucciones → contexto permanente → estado del sprint → fragmentos) para aprovechar
  la caché de prompts, y las historias terminadas se resumen por épica.
- **Idioma desde BMAD**: las respuestas usan `communication_language` y las historias redactadas `document_output_language`
  (de `_bmad/core/config.yaml` y `_bmad/bmm/config.yaml`; el de bmm prevalece). Sin configuración, responde en el idioma del usuario.
- Errores claros: key inválida, sin créditos (Claude), límite por minuto/día o petición demasiado grande (Groq).

Endpoints: `POST /api/ai/validate` (devuelve los modelos disponibles) y `POST /api/ai/chat` (stream NDJSON), con `provider` en el cuerpo y la key en la cabecera `x-ai-key`.

## Conversaciones del asistente

Con sesión iniciada, cada turno del chat se guarda en Supabase y se puede reabrir desde **🗂 Conversaciones**
(también renombrar, eliminar, exportar e importar).

**Modelo de datos** (RLS por usuario):
- `ai_conversations`: un registro por hilo (título, proveedor, modelo, historia en foco, contadores de mensajes y tokens).
- `ai_messages`: **una fila por mensaje**, solo se añaden (nunca se reescribe el hilo). `role` = `user` | `assistant` | `system`.
  - `context` (mensajes de usuario, `jsonb`): qué se envió como contexto — **referencias** (`permanent`, `section`, `focus-story`,
    `sprint-state`) con ruta, sección, tamaño y fecha del archivo. No se copia el contenido de PRD/arquitectura.
  - `usage` (respuestas, `jsonb`): tokens de entrada/salida/caché, proveedor, modelo y motivo de fin.
  - `system`: notas del dashboard (conversación cargada, cambio de proveedor/modelo, historia en foco). No se envían al modelo.

Al reabrir una conversación el contexto se reconstruye con los archivos actuales y se avisa si alguno cambió o ya no existe.

**Formato JSON** de exportación/importación (`format: "bmad-dashboard.conversation"`, `version: 1`):
`{ format, version, exportedAt, project, conversation: { id, title, provider, model, focusStory, createdAt, updatedAt },
messages: [ { seq, role, content, createdAt, context?, usage? } ] }`.

## Trabajar desde el dashboard

- **Mover historias**: arrastra una tarjeta del tablero (o usa "Mover a" en el detalle). Se actualizan `sprint-status.yaml`
  (conservando comentarios) y el `Status:` del archivo de la historia (formato v6 o v4).
- **Corregir desincronizaciones**: en Alertas o en el detalle, elige qué estado vale (el de sprint-status o el del archivo).
- **Marcar tareas**: las casillas del detalle escriben `- [x]` en el archivo.
- **Puerta de calidad**: al pasar a review/done avisa si hay pruebas fallando o un PR abierto.

Funciona en modo carpeta (Chrome/Edge) y en modo local; en la vista de la nube es de solo lectura.

## Métricas del sprint

Al sincronizar (sesión iniciada) se registran los cambios de estado en `story_events` (Supabase, con RLS). La pestaña **Métricas**
muestra historias terminadas por semana, cycle time (in-progress → done), tiempo medio en cada estado, historias detenidas
(más de 2 días en progreso o revisión) y una previsión de fecha por épica según el ritmo reciente.

**Uso del asistente** (misma pestaña): cada petición (chat, redactar, revisar) se registra en `ai_usage` con tokens de entrada,
salida y caché, proveedor, modelo y número de secciones de documentos enviadas. Se muestra para 7/30/90 días: tokens totales y por día,
peticiones, media por petición, % desde caché, desglose por tarea y por modelo, efecto de los documentos en el chat y coste estimado
(Groq Free = $0; Claude con precios de lista). El historial de uso no depende de las conversaciones: borrar un hilo no lo borra.

## Git y pruebas

- **GitHub**: el repositorio se detecta desde `.git/config` (o se escribe a mano); token opcional de solo lectura para repos privados,
  guardado solo en el navegador. Ramas y PRs se vinculan a historias por su clave (`1-3-login-con-jwt`) o id (`story-1.3`, `[1.3]`).
  Alertas: historia done con PR abierto, PR abierto con la historia sin empezar, PR fusionado sin marcar la historia como done.
- **Pruebas**: lee reportes JUnit (Maven Surefire/Failsafe, Gradle, `junit*.xml`) y TRX (.NET). Asocia las clases de prueba con los archivos
  de la *File List* de cada historia (`LoginService.java` ↔ `LoginServiceTest`) y muestra resultados en el tablero, el detalle y las alertas.

## Vistas

- **Resumen**: KPIs, distribución por estado, tendencia del sprint, foco actual, progreso por épica, siguiente paso, actividad y artefactos.
- **Tablero**: kanban `backlog → drafted → ready-for-dev → in-progress → review → done` con filtros.
- **Épicas**: progreso, estado declarado vs. real, retrospectiva.
- **Próximos pasos**: comandos priorizados (code-review, dev-story, story-context, create-story, retrospective…) con botón de copiar.
  Formato elegible: `/bmad:bmm:workflows:*`, agente + `*menú`, `/bmad-bmm-*` o v4 (`@dev *develop-story`).
- **Nueva historia**: formulario → markdown con la plantilla BMAD (v6/v4), checklist de calidad, guardado en la carpeta y registro en `sprint-status.yaml`.
- **Alertas**: estados desincronizados, historias `done` con tareas abiertas, historias sin archivo, épicas por cerrar.

## Desarrollo local

```bash
cp .env.example .env      # opcional: Supabase
npm install
npm run build && npm run start:prod    # http://localhost:3737
```

Variables: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `PORT` (3737), `HOST` (127.0.0.1), `LOCAL_FS` (true fuera de Vercel), `BMAD_DEFAULT_DIR`.

## Despliegue en Vercel

`vercel.json` compila Nest (`npm run build`), sirve `public/` como estático y enruta `/api/*` a `api/index.js`,
que reutiliza la app Nest compilada (`dist/serverless.js`). Configura `SUPABASE_URL` y `SUPABASE_PUBLISHABLE_KEY` en el proyecto.

En Supabase → Authentication → URL Configuration, pon la URL de Vercel como **Site URL** y añádela a **Redirect URLs**
para que el enlace de acceso por email vuelva a la app.

## Base de datos (Supabase)

| Tabla | Contenido |
|---|---|
| `projects` | Un registro por usuario y carpeta (`owner_id`, `root_label`, nombre, versión BMAD) |
| `snapshots` | Estado completo del dashboard (`jsonb`) + contadores para la tendencia; solo se inserta si el estado cambió |
| `story_specs` | Especificaciones generadas (markdown, checklist, si se guardó en disco) |

Todas con **RLS**: cada usuario solo lee y escribe sus filas. La API usa la clave publishable con el JWT del usuario.

## API

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/config` | Modo, configuración pública de Supabase y reglas de escaneo |
| POST | `/api/analyze` | Analiza los archivos enviados por el navegador → dashboard |
| POST | `/api/spec/build` | Genera la historia (y el `sprint-status.yaml` actualizado) |
| GET/POST/DELETE | `/api/projects`, `/api/projects/sync`, `/api/projects/:id/{history,latest,specs}` | Nube (requiere `Authorization: Bearer <jwt>`) |
| GET/POST | `/api/local/{detect,dashboard,story,fs,spec/save}` | Solo modo local |

## Estructura

```
api/index.js                 # función de Vercel → dist/serverless.js
src/
  main.ts / serverless.ts    # arranque local / Vercel
  bmad/core/                 # análisis puro: parsers, analizador, sugerencias, generador de historias
  bmad/analyze.controller.ts # /api/analyze, /api/spec/build
  bmad/local/                # modo local (lee el disco)
  projects/                  # proyectos, snapshots y specs en Supabase
public/                      # frontend sin build (HTML + CSS + JS)
```
