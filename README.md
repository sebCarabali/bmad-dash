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
- **Idioma desde BMAD**: las respuestas usan `communication_language` y las historias redactadas `document_output_language`
  (de `_bmad/core/config.yaml` y `_bmad/bmm/config.yaml`; el de bmm prevalece). Sin configuración, responde en el idioma del usuario.
- Errores claros: key inválida, sin créditos (Claude), límite por minuto/día o petición demasiado grande (Groq).

Endpoints: `POST /api/ai/validate` (devuelve los modelos disponibles) y `POST /api/ai/chat` (stream NDJSON), con `provider` en el cuerpo y la key en la cabecera `x-ai-key`.

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
