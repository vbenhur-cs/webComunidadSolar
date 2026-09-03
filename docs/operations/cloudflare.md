# Operación Cloudflare

Cloudflare Workers es el destino aprobado para este proyecto. El CD de preview
y su evidencia están implementados en GitHub Actions. El workflow de producción
existe, pero falla cerrado hasta completar D1, Access, dominio, credenciales y
una habilitación expresa. Mientras `comunidadsolar.es` continúa en Raiola, el
entorno de pruebas se publica en el subdominio gratuito `workers.dev`, sin
cambiar DNS ni nameservers.

## Credencial mínima para Wrangler y CI

Usa un **Account API Token** limitado únicamente a la cuenta de Comunidad
Solar. Es el tipo adecuado para una integración duradera de CI/CD. Su política
mínima para este proyecto es:

| Recurso | Permiso | Motivo |
| --- | --- | --- |
| Account | Workers Scripts: Write | Crear y actualizar el Worker y sus assets. |
| Account | D1: Edit | Crear/consultar D1 y aplicar migraciones. |
| Account | Workers KV Storage: Edit | Wrangler aprovisiona el namespace `SESSION` que el adaptador de Astro genera para las sesiones. |

No concedas DNS, Zone, Billing, API Tokens, Workers Routes ni R2 para el
preview `workers.dev`. Si en el futuro se automatiza Cloudflare Access o un
dominio personalizado, usa preferiblemente credenciales separadas y añade
solo el permiso concreto durante esa fase.

Estos permisos se conceden al nivel completo de la cuenta: Cloudflare no
permite reducirlos a un Worker, una base D1 o un namespace KV concretos. Usa
tokens distintos para preview y producción y secretos separados en los
environments de GitHub como control de proceso, pero no los confundas con un
aislamiento de autorización. Si preview y producción requieren una frontera
exigible por credencial, deben vivir en cuentas Cloudflare distintas.

Referencias oficiales: [Account API Tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/),
[permisos de API tokens](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
y [GitHub Actions para Workers](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).

Para crear un token nuevo desde el panel:

1. Abre **Manage Account > Account API Tokens**.
2. Pulsa **Create Token** y selecciona una política personalizada.
3. Añade los tres permisos de la tabla y limita **Account resources** a la
   cuenta concreta, no a todas las cuentas.
4. Ponle un nombre como `comunidad-solar-preview-cd`, define caducidad si el
   procedimiento de rotación lo permite y crea el token.
5. Copia el valor en ese momento: Cloudflare no vuelve a mostrarlo.

En el `.env` local ignorado por Git, Wrangler reconoce estas variables de
sistema:

```dotenv
CLOUDFLARE_ACCOUNT_ID=<account-id>
CLOUDFLARE_API_TOKEN=<account-api-token>
```

No las añadas a `.env.example`: esa plantilla representa bindings que puede
recibir el Worker, mientras que estas dos variables autentican al operador.
La build fuerza el perfil indicado por el proceso —o el perfil base si no se
indica ninguno—, desactiva la importación de `.env` en las variables de
runtime y analiza `dist/` al terminar. Si encuentra un archivo de entorno o
alguna de estas credenciales, falla antes de poder publicar el artefacto.
En el environment de GitHub `preview`, guarda `CLOUDFLARE_ACCOUNT_ID` como
variable de entorno y `CLOUDFLARE_API_TOKEN` como secret. El workflow los
inyectará solo en el job de despliegue:

```yaml
env:
  CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
  CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

La configuración completa de GitHub también incluye la URL y el perfil
saneable. Se detalla en «Configurar GitHub Actions» más abajo.

## Crear el dominio gratuito de pruebas

`workers.dev` no es un dominio que haya que comprar. La cuenta elige una vez
su subdominio global y cada Worker recibe una URL dentro de él.

1. En Cloudflare abre **Workers & Pages**.
2. Junto a **Your subdomain**, pulsa **Change**.
3. Elige un nombre disponible, por ejemplo `comunidadsolar-dev`, y confirma.
4. Publica el Worker con el nombre `comunidad-solar-preview` y
   `workers_dev: true`.
5. La URL resultante tendrá esta forma:

   ```text
   https://comunidad-solar-preview.comunidadsolar-dev.workers.dev
   ```

   Sustituye `comunidadsolar-dev` por el subdominio realmente registrado.

El nombre global de la cuenta es visible y afecta a todos sus Workers; decide
el definitivo antes de confirmarlo. En la configuración de preview mantén
`SITE_INDEXABLE="false"`, una base D1 exclusiva de pruebas y, antes de
compartir la URL, protege el Worker con Cloudflare Access si no debe ser
público. El perfil externo mínimo tendrá esta forma (el UUID real se conserva
fuera del repositorio):

```jsonc
{
  "name": "comunidad-solar-preview",
  "main": "./src/worker.ts",
  "compatibility_date": "2026-08-21",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": true,
  "preview_urls": true,
  "assets": {
    "binding": "ASSETS",
    "directory": "./dist",
    "run_worker_first": true,
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "comunidad-solar-preview",
      "database_id": "<UUID-D1-PREVIEW>",
      "migrations_dir": "drizzle",
    },
  ],
  "vars": { "SITE_INDEXABLE": "false" },
  "observability": { "enabled": true },
}
```

Cuando la web esté aprobada, se conectará el dominio personalizado en una
operación distinta. Hasta entonces `comunidadsolar.es` y su DNS permanecen
íntegros en Raiola.

Cloudflare documenta la creación, formato y protección de estas URL en
[workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).

## Configurar GitHub Actions para preview

### 1. Preparar el perfil fuera del repositorio

Guarda el perfil real en una ruta segura ajena al checkout, por ejemplo
`/ruta/segura/comunidad-solar-preview.jsonc`. Debe coincidir con el modelo
anterior y contener el UUID de la D1 de pruebas; no debe contener tokens,
secretos de runtime ni datos reales. Valídalo localmente:

```bash
CLOUDFLARE_CONFIG_PATH=/ruta/segura/comunidad-solar-preview.jsonc \
npm run preview:cloudflare
```

### 2. Crear el environment y cargar sus cuatro valores

Desde un `gh` autenticado con administración del repositorio:

```bash
gh api --method PUT \
  repos/vbenhur-cs/webComunidadSolar/environments/preview

base64 < /ruta/segura/comunidad-solar-preview.jsonc | gh secret set CLOUDFLARE_PREVIEW_CONFIG_B64 --env preview
gh secret set CLOUDFLARE_API_TOKEN --env preview
gh variable set CLOUDFLARE_ACCOUNT_ID --env preview --body "ACCOUNT_ID_FROM_CLOUDFLARE"
gh variable set CLOUDFLARE_PREVIEW_URL --env preview --body "https://comunidad-solar-preview.comunidadsolar-dev.workers.dev"
```

El segundo comando pide el token de forma interactiva y no lo muestra. Reemplaza
`ACCOUNT_ID_FROM_CLOUDFLARE` localmente por el Account ID real; es un
placeholder y nunca se copia al repositorio. Tampoco se versionan el UUID D1,
los bytes base64 del perfil ni el token.

Comprueba solo los nombres, nunca sus valores:

```bash
gh secret list --env preview
gh variable list --env preview
```

El contrato exacto es:

| Environment | Tipo | Nombre |
| --- | --- | --- |
| `preview` | variable | `CLOUDFLARE_ACCOUNT_ID` |
| `preview` | variable | `CLOUDFLARE_PREVIEW_URL` |
| `preview` | secret | `CLOUDFLARE_API_TOKEN` |
| `preview` | secret | `CLOUDFLARE_PREVIEW_CONFIG_B64` |

El environment `preview` no lleva aprobación humana: solo limita la entrega de
su configuración a los jobs confiables. El código candidato se compila en otro
job sin secretos.

### 3. Crear la aprobación anterior al merge

En **Settings → Environments → New environment**, crea `premerge-review` y
configura al propietario actual del repositorio como **required reviewer**.
Mientras exista un único revisor, deja **prevent self-review** desactivado para
que no haya un bloqueo circular. Cuando se incorpore una segunda persona,
activa esa opción y exige también una aprobación de PR ajena al autor.

El reviewer debe abrir los enlaces base/candidato y los PNG permanentes antes
de aprobar el deployment pendiente. Aprobar el environment solo permite crear
el status `preview-approved` para el SHA exacto que generó la evidencia.

### 4. Mantener producción cerrada

Crea el environment `production` para reservar su frontera de aprobación, pero
durante el bootstrap déjalo **sin credenciales de producción**. La variable
`PRODUCTION_ENABLED` debe estar ausente o tener un valor distinto de la cadena
literal `true`. No cargues todavía:

- `CLOUDFLARE_PRODUCTION_API_TOKEN`;
- `CLOUDFLARE_PRODUCTION_CONFIG_B64`;
- `CLOUDFLARE_PRODUCTION_ACCOUNT_ID`; ni
- `CLOUDFLARE_PRODUCTION_URL`.

El workflow `.github/workflows/production.yml` es manual y vuelve a comprobar
esta condición antes de llamar a GitHub o Cloudflare. Su existencia no autoriza
una publicación.

### 5. Protección del repositorio

Durante la PR que incorpora por primera vez el pipeline se usa temporalmente:

```bash
gh variable set PREVIEW_PIPELINE_BOOTSTRAP_PR --body "<NUMERO_PR_PIPELINE>"
```

El valor debe ser únicamente el número de esa PR. Elimínalo inmediatamente
después de que su push a `main` termine:

```bash
gh variable delete PREVIEW_PIPELINE_BOOTSTRAP_PR
```

Inicializa la rama huérfana `evidence` con un `README.md` y protégela frente a
eliminaciones y force-push. La identidad `github-actions[bot]` debe poder añadir
commits normales; ninguna persona ni workflow debe reescribir los anteriores.

La regla de `main` exige PR, historial lineal, conversaciones resueltas y los
checks `production-readiness` y `preview-approved`, además de bloquear deletes
y force-push. Añade `preview-approved` solo después de que una PR real lo haya
producido correctamente; antes de esa prueba conserva únicamente
`production-readiness` para no bloquear el bootstrap.

## Datos necesarios para habilitar CD

- Cuenta Cloudflare con Workers habilitado. La zona DNS solo será necesaria al
  conectar el dominio personalizado de producción.
- `CLOUDFLARE_ACCOUNT_ID`.
- Un `CLOUDFLARE_API_TOKEN` distinto por entorno, limitado a la cuenta con
  `Workers Scripts: Write`, `D1: Edit` y `Workers KV Storage: Edit`. Dentro de
  la misma cuenta, esos scopes no aíslan un Worker o una D1 de otros recursos.
- Una base D1 de preview y otra de producción, preferiblemente con jurisdicción
  `eu`, ambas enlazadas como `DB`.
- Perfiles Wrangler externos para preview y producción.
- Un entorno GitHub `production` con aprobación manual.
- Allowlists de socios, equipo y Manganáfer, más los secretos y parámetros
  operativos de Manganáfer.
- Una aplicación Cloudflare Access para las rutas privadas y la adaptación del
  Worker para consumir su identidad verificada.

No guardes tokens, allowlists ni perfiles operativos dentro del repositorio.
El Account ID no es secreto, pero se mantiene como configuración del entorno;
los secretos se introducen en los environments de GitHub o en Cloudflare una
vez creados los recursos.

## Perfil de despliegue

El `wrangler.jsonc` del repositorio usa deliberadamente un identificador D1
local. No es un perfil publicable. Una publicación futura debe partir de un
archivo de operador externo, con un `database_id` de preview o producción, y
validarlo antes de usarlo:

```bash
CLOUDFLARE_CONFIG_PATH=/ruta/segura/comunidad-solar-preview.jsonc \
npm run preview:cloudflare
```

`preview:cloudflare` valida el nombre, `main`, assets, compatibilidad de
Workers, el único binding `DB`, su directorio de migraciones, UUID D1 y
`SITE_INDEXABLE`. Las rutas se interpretan contra la raíz explícita del
proyecto y se rebajan de forma segura para la copia en artifacts. Rechaza
secretos literales, rutas inseguras y symlinks. No modifica el perfil del
operador: escribe sólo una copia canónica saneada y sin secretos en
`.artifacts/config/`. Su SHA-256 e indexabilidad se imprimen como metadatos de
operación; no se imprimen valores de bindings ni secretos.

El procedimiento recomendado usa perfiles independientes con nombres de
Worker y D1 explícitos. Si se selecciona `CLOUDFLARE_ENV`, la copia conserva
únicamente el environment nombrado y sus bindings D1/`SITE_INDEXABLE`, de modo
que Astro y Wrangler seleccionan el mismo target. La compatibilidad segura requerida
(`compatibility_date` y `nodejs_compat`) permanece en el perfil saneado.

`.env.example` enumera los bindings sin valores. Los valores operativos se
inyectan desde el almacén de secretos del entorno, nunca mediante un archivo
`.dev.vars` persistente ni mediante el repositorio.

```bash
npm run deploy:dry
```

`deploy:dry` es una comprobación local y determinista del perfil del
repositorio: permite inspeccionar únicamente su UUID D1 local, deja una copia
saneada ignorada, ejecuta la build con esa copia, comprueba la topología emitida
y ejecuta `wrangler deploy --dry-run` sobre el `dist/server/wrangler.json`
generado por Astro. Wrangler recibe el artefacto sin credenciales Cloudflare y
no lo sube ni publica; este comando no es una autorización de publicación.
