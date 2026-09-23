# CLAUDE.md

Contexto del proyecto para agentes de IA (Claude Code y similares).

## Qué es

**markea-mcp**: hub de servidores MCP (Model Context Protocol) de Markea Group, desplegado como funciones serverless en **Vercel** bajo `https://ai.markeagroup.com`. Cada MCP es un proxy autenticado hacia un servicio externo: las API keys viven solo en el servidor y los clientes (connectors de claude.ai, Claude Code) solo conocen el token del hub.

Servidores actuales (fuente de verdad: `servers/registry.ts`):

| id    | Endpoint           | Qué hace |
|-------|--------------------|----------|
| `fal` | `/fal-ia/mcp` (+ `/fal-ia/upload`) | Fal.ai: imagen, video, audio, jobs async, uploads a CDN, schemas y pricing |

`GET /health` lista los servidores del registro (público, sin secretos).

## Stack

- Node.js ≥ 20, TypeScript strict (`module: NodeNext`, compila a CJS: `package.json` no tiene `"type": "module"`)
- `@modelcontextprotocol/sdk` directo (`McpServer.registerTool` + `StreamableHTTPServerTransport`), sin framework
- `zod` v3 para input schemas
- `@vercel/node` / CLI `vercel`
- Sin base de datos, sin tests

## Estructura

```
api/                       # SOLO entrypoints de Vercel (una función por archivo)
  health.ts                # GET /health → lista del registro
  fal-ia/mcp.ts            # createMcpHandler(createFalServer, SERVERS.fal)
  fal-ia/upload.ts         # POST multipart/binario → CDN de Fal
lib/                       # Infra compartida por todos los MCP
  mcp-handler.ts           # createMcpHandler(): CORS + OPTIONS + auth + transport stateless
  auth.ts                  # isAuthorized(req, meta): token de header y token de URL separados, fail closed
  cors.ts                  # CORS solo para orígenes en allowlist (claude.ai)
  http.ts                  # header(), queryParam(), sendJson(), readBody()
  tools.ts                 # textResult(), toolError()
  multipart.ts             # parser multipart/form-data sin dependencias
servers/
  registry.ts              # SERVERS: metadatos de cada MCP (sin importar su código)
  fal/
    client.ts              # llamadas a Fal (REST + cliente MCP mínimo hacia mcp.fal.ai)
    catalog.ts             # catálogo curado estático de modelos
    server.ts              # createFalServer(): registra las 11 tools
vercel.json                # rewrites genéricos /:service/mcp → /api/:service/mcp, maxDuration 300 s
```

Regla: `api/` solo cablea; la lógica va en `servers/<id>/` y lo común en `lib/`. `servers/registry.ts` no importa código de servidores para que `/health` no empaquete todos los MCP.

## Comandos

```bash
npm run dev         # vercel dev (servidor local)
npm run typecheck   # tsc --noEmit — única verificación automática
npm run deploy      # vercel deploy --prod
```

Probar tools a mano: `npx @modelcontextprotocol/inspector` apuntando a `http://localhost:3000/fal-ia/mcp`.

## Agregar un MCP nuevo

1. **Registro** — agregar entrada en `servers/registry.ts`:
   ```ts
   cm: { id: "cm", name: "markea-cm", version: "1.0.0", description: "…", path: "/cm/mcp", tokenEnv: "MCP_TOKEN_CM", urlTokenEnv: "MCP_URL_TOKEN_CM" },
   ```
   `urlTokenEnv` solo si el MCP se va a usar desde connectors de claude.ai; si se omite, `?token=` nunca se acepta.
2. **Cliente del servicio** — `servers/cm/client.ts`: funciones tipadas que llaman a la API externa y lanzan `Error` con status + body si falla. Keys desde `process.env`, validadas al usarse (no al importar).
3. **Tools** — `servers/cm/server.ts` exporta `createCmServer(): McpServer` usando `SERVERS.cm.name/version`. Cada tool con `server.registerTool(name, { title, description, annotations, inputSchema }, handler)`, schema `zod` con `.describe()`, handler en `try/catch` → `toolError(err)`.
4. **Entrypoint** — `api/cm/mcp.ts`:
   ```ts
   import { createMcpHandler } from "../../lib/mcp-handler";
   import { SERVERS } from "../../servers/registry";
   import { createCmServer } from "../../servers/cm/server";

   export default createMcpHandler(createCmServer, SERVERS.cm);
   ```
   El nombre de la carpeta en `api/` **es** la URL pública (`/cm/mcp`); no hace falta tocar `vercel.json`.
5. **Env vars** — agregar las keys del servicio, `MCP_TOKEN_CM` (y `MCP_URL_TOKEN_CM` si aplica) a `.env.example` y a Vercel.
6. `npm run typecheck`, probar con el Inspector y actualizar la tabla de servidores de este archivo.

## Variables de entorno

| Variable            | Uso |
|---------------------|-----|
| `FAL_API_KEY`       | Obligatoria para `fal`. Se envía como `Authorization: Key <key>` (REST) o `Bearer <key>` (MCP de Fal). |
| `MCP_TOKEN_<ID>`    | Token **de header** (`Authorization: Bearer`) del servidor (`tokenEnv`), p. ej. `MCP_TOKEN_FAL`. Para Claude Code y scripts. |
| `MCP_BEARER_TOKEN`  | Respaldo global del token de header para servidores sin `MCP_TOKEN_<ID>`. |
| `MCP_URL_TOKEN_<ID>`| Token **de URL** (`?token=`) del servidor (`urlTokenEnv`), p. ej. `MCP_URL_TOKEN_FAL`. Solo para connectors de claude.ai. Debe ser distinto del de header. **Sin respaldo**: si no está, `?token=` queda desactivado. |
| `MCP_ALLOW_OPEN`    | `true` deja abiertos los servidores sin ningún token. Solo para pruebas locales; nunca en producción ni Preview. |

Cada token solo vale en su lugar: el de header no sirve en la URL y viceversa. Si llega header `Authorization`, se evalúa solo el header. Sin ningún token configurado, todo responde 401 (fail closed). Comparación en tiempo constante. `/fal-ia/upload` acepta solo el token de header.

URLs resultantes:
```
Claude Code:  https://ai.markeagroup.com/fal-ia/mcp                + header Authorization: Bearer <MCP_TOKEN_FAL>
claude.ai:    https://ai.markeagroup.com/fal-ia/mcp?token=<MCP_URL_TOKEN_FAL>
```
Si se filtra la URL de un connector, se rota solo `MCP_URL_TOKEN_<ID>` sin afectar a los clientes por header.

## Convenciones

- Código, comentarios y descripciones de tools en **inglés**; commits mezclan inglés/español con prefijos `fix:` / `feat:`.
- Imports relativos **sin extensión** (`"../../lib/tools"`); los del SDK sí con `.js` (`"@modelcontextprotocol/sdk/server/mcp.js"`).
- Respuestas de tools: texto plano legible (listas con `•`, pares `clave: valor`) o `JSON.stringify(result, null, 2)`. Nunca lanzar desde un handler: devolver `toolError(err)`.
- Separar tools con el banner `// ── nombre ──…`.
- **Stateless siempre**: nada de estado en memoria entre requests. Cada invocación crea `McpServer` + transport nuevos (lo hace `createMcpHandler`).
- Mantener cada MCP con pocas tools y enfocado a su servicio; no mezclar servicios en un mismo servidor.

## Seguridad

Reglas que cualquier MCP nuevo debe respetar:

- **Nunca hacer fetch a una URL que venga del cliente con credenciales del servidor.** Si una tool recibe una URL (como `check_job`), validar protocolo `https:` y host exacto del servicio antes de llamar (ver `falQueueCheck`). Construir URLs siempre sobre una base fija.
- **Tratar los inputs de las tools como no confiables**: pueden venir de un prompt injection. Validar con `zod` y restringir lo que genere costo o efectos externos.
- **Uploads**: solo tipos de media que los modelos consumen (`image/*` salvo SVG, `video/*`, `audio/*`), porque quedan públicos en la CDN del servicio con nuestra cuenta.
- **Errores**: no incluir keys ni headers en mensajes; `toolError` devuelve el texto al cliente tal cual.
- **Costos**: no hay rate limit ni allowlist de modelos en `run_model` / `submit_job`; el límite de gasto real está en el dashboard de Fal.
- Dependencias de producción: `npm audit --omit=dev` debe quedar en 0. Las alertas restantes son del tooling de desarrollo (`vercel`, `@vercel/node`), que no se despliega.

## MCP `fal` — detalles

Helpers en `servers/fal/client.ts`:
- `falRun` → `POST https://fal.run/{endpoint_id}` (síncrono)
- `falQueueSubmit` → `POST https://queue.fal.run/{endpoint_id}`
- `falQueueCheck` → `GET` sobre `status_url` / `response_url` devueltas por el submit
- `falInitiateUpload` / `falStorageUpload` → `POST https://rest.alpha.fal.ai/storage/upload/initiate` + `PUT` prefirmado
- `proxyToFalMcp` → cliente MCP mínimo contra `https://mcp.fal.ai/mcp` (handshake completo por llamada; soporta JSON y SSE)

| Tool               | Backend | Notas |
|--------------------|---------|-------|
| `generate_image`   | `falRun` | Default `fal-ai/flux/dev`, `landscape_16_9`, 1 imagen. |
| `run_model`        | `falRun` | Cualquier `endpoint_id` + `input`. Para tareas < ~60 s. |
| `submit_job`       | `falQueueSubmit` | Devuelve `request_id`, `status_url`, `response_url`. Video y tareas largas. |
| `check_job`        | `falQueueCheck` | Una sola `url` (status o response). Solo acepta `https://queue.fal.run/...`. |
| `initiate_upload`  | `falInitiateUpload` | `upload_url` (PUT) + `file_url`. Recomendado > 1 MB. Valida MIME. |
| `upload_file`      | `falStorageUpload` | Base64, solo < ~3 MB. `file_name` se acepta por compatibilidad pero no se usa. |
| `get_model_schema` / `get_pricing` / `search_docs` | `proxyToFalMcp` | |
| `search_models` / `recommend_model` | `catalog.ts` | Local, sin llamar a Fal. |

`POST /fal-ia/upload`: `multipart/form-data` (campo `file`) o binario crudo con su `Content-Type`. Misma auth que `/fal-ia/mcp`. Responde `{ file_url }`.

## Gotchas y contexto histórico

- **`check_job` / queue de Fal** tuvo mucha iteración (ver `git log`): reconstruir URLs con `endpoint_id`, POST vs GET, proxy vía MCP de Fal. Estado actual: usar **directamente** las URLs del submit con **GET**. Fal puede devolver paths truncados (p. ej. `fal-ai/kling-video`), no reconstruir sin verificar. Probar contra Fal real antes de tocarlo.
- **Límite de body de Vercel (~4.5 MB)** en todas las funciones, incluido `/fal-ia/upload` (bufferiza el body). Archivos grandes: `initiate_upload` + PUT directo del cliente a Fal.
- **Timeouts**: `maxDuration` 300 s. Todo lo que pueda tardar → patrón submit + check.
- **Auth fail closed**: sin token configurado todo responde 401 (y se loguea `[auth] No token configured`). El `?token=` queda en logs de Vercel/proxies; por eso es un token aparte y rotable. OAuth (diseño con Supabase Auth como servidor OAuth 2.1 + login Google con allowlist de dominios) quedó pospuesto.
- **Rewrites genéricos**: `/:service/mcp` y `/:service/upload` apuntan a `/api/:service/...`; si la función no existe, Vercel responde 404.
- `servers/fal/catalog.ts` está hardcodeado y puede quedar desactualizado; para info real usar `get_model_schema` / `search_docs`.
- `rest.alpha.fal.ai` es un endpoint "alpha" de Fal; si fallan los uploads, revisar primero ahí.

## Estado del repo

- Rama principal: `main`. Despliegue con `npm run deploy` (o integración Git de Vercel).
- Antes de desplegar: confirmar en Vercel (Production **y** Preview) que existe `MCP_BEARER_TOKEN` o `MCP_TOKEN_FAL`, y `MCP_URL_TOKEN_FAL` si hay connectors de claude.ai usando `?token=`.
