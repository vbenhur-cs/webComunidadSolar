# Runbook de pruebas, despliegue y cambios en producción

Este documento explica cómo preparar, probar y liberar Comunidad Solar Astro
en Cloudflare Workers. Está dirigido a autores, revisores y responsables de
release. Separa la preview operativa de la producción deliberadamente cerrada.

## Estado y regla principal

El repositorio ya dispone de:

- una CLI para recibir, generar y validar páginas con dos aprobaciones humanas;
- comprobaciones locales y el gate `production-readiness`;
- previews Cloudflare exactas del base y candidato de cada PR interna;
- capturas PNG desktop/móvil y manifiestos append-only en `evidence`;
- aprobación protegida `premerge-review` antes del merge;
- despliegue automático del SHA integrado a la preview compartida; y
- un workflow manual de producción que falla cerrado.

Cloudflare Workers es el alojamiento aprobado. La preview compartida es
`https://comunidad-solar-preview.comunidadsolar-dev.workers.dev` y mantiene
`SITE_INDEXABLE=false`. `comunidadsolar.es`, sus DNS y Raiola quedan fuera de
este flujo.

`deploy:dry` continúa siendo una validación local y no publica. La preview sí
usa uploads/versiones reales desde workflows confiables. Producción no está
habilitada: `PRODUCTION_ENABLED` permanece ausente o distinto de `true` y no se
instalan credenciales productivas durante el bootstrap. No se ejecuta un
despliegue manual desde un ordenador personal.

## Responsabilidades mínimas

| Rol | Responsabilidad |
| --- | --- |
| Autor del cambio | Crea la rama, ejecuta las pruebas locales y abre la PR. |
| Revisor | Revisa código/contenido, CI, ambas previews y evidencia visual. |
| Aprobador de preview | Autoriza `premerge-review` para el SHA exacto después de comparar el antes y el después. |
| Responsable de release | Fusiona solo con gates verdes, confirma la preview compartida y, en el futuro, aprueba `production`. |
| Administrador Cloudflare | Gestiona D1, dominios y credenciales con mínimo privilegio. |

Ningún token, contraseña, fichero `.dev.vars` ni perfil Cloudflare de
producción se guarda en Git, en una PR o en el workspace de un agente.

---

## 1. Preparar el equipo local

Realiza estos pasos al iniciar una tarea o tras cambiar de rama.

1. Entra en el checkout Astro y comprueba que no hay trabajo ajeno:

   ```bash
   cd /ruta/a/comunidadsolar-astro
   git status --short
   ```

   Si hay cambios que no son tuyos, detente y consúltalo antes de continuar.

2. Usa Node 22, que es la versión fijada por el proyecto:

   ```bash
   nvm use
   node --version
   ```

3. Instala exactamente las dependencias bloqueadas:

   ```bash
   npm ci
   ```

4. Si ya existe un remoto, sincroniza `main` sin crear un merge local y abre
   una rama con un nombre descriptivo:

   ```bash
   git switch main
   git pull --ff-only origin main
   git switch -c feat/<descripcion-corta>
   ```

   Si `git remote -v` no devuelve nada, primero completa la sección
   «Habilitación inicial: repositorio y CI».

5. Arranca el entorno de desarrollo solo cuando necesites inspección manual:

   ```bash
   npm run dev
   ```

   Este comando selecciona `wrangler.dev.jsonc`: en local, el binding de assets
   apunta a `public/` y Vite sirve primero imágenes, estilos y módulos de
   hidratación, mientras que las páginas y rutas que no son assets siguen
   llegando al Worker/Astro en vivo. `wrangler.jsonc` apunta a `dist/` y
   conserva el orden inverso necesario en producción. No arranques `astro dev`
   directamente, porque omitirías este perfil local.

   No copies secretos de producción a `.dev.vars`. La plantilla
   [`.env.example`](../../.env.example) solo enumera los bindings permitidos.

## 2. Pruebas locales antes de abrir una PR

Ejecuta esta secuencia desde la raíz de `comunidadsolar-astro`. Todos los
comandos deben terminar con código 0.

```bash
npm run source:check -- --if-present
npm run format:check
npm run lint
npm run check
npm test
npm run test:integration
npm run test:dev
npm run verify:public
npm run verify:links
npm run verify:server
npm run deploy:dry
```

Qué comprueba cada paso:

- `source:check` comprueba la referencia de paridad cuando el checkout fuente
  está disponible; `--if-present` permite trabajar de forma independiente.
- `format:check`, `lint` y `check` cubren formato, ESLint, tipos y diagnósticos
  de Astro/Wrangler.
- `npm test` ejecuta la suite unitaria, de contratos, servidor e ingestión.
- `test:integration` prueba la persistencia sobre un D1 local aislado.
- `test:dev` y `verify:public` recorren el servidor de desarrollo y el Worker
  generado con Chromium, incluidos imágenes, menús, hidratación y formularios.
- `verify:links` y `verify:server` cierran los inventarios público y privado.
- `deploy:dry` prepara un perfil local saneado, construye, verifica la topología
  emitida y obliga a Wrangler a procesar el bundle generado con `--dry-run`.
  No sube ni publica nada.

Antes del primer push del repositorio o de una entrega estructural, añade la
verificación del archive Git independiente:

```bash
npm run verify:independent
```

`test:dev` arranca el servidor Astro real con el perfil local, recorre todas
las rutas públicas y comprueba imágenes, errores del navegador, hidratación de
los menús, navegación móvil, redirects, metadatos y persistencia del formulario
Manganáfer en D1 local. Los enlaces deliberadamente externos —como las
calculadoras— no forman parte del runtime local.

No avances a PR si una prueba falla. Reproduce el fallo, conserva su salida y
resuélvelo antes de reintentar el resto de la secuencia.

## 3. Flujo para una página nueva

Hay dos caminos. Elige uno y no los mezcles en la misma entrega sin revisión
explícita.

### A. Página o cambio editorial desarrollado en el repositorio

1. Crea la ruta, componente, contenido, assets locales y pruebas que requiera
   el cambio.
2. Actualiza los contratos, SEO, rutas y documentación aplicables.
3. Ejecuta toda la sección «Pruebas locales antes de abrir una PR».
4. Describe en la PR el propósito, rutas afectadas, datos personales o
   migraciones implicadas y el resultado de las pruebas.

### B. Página aportada que pasa por la CLI de ingestión

Ejecuta este flujo en un checkout limpio y sin credenciales de producción. Las
operaciones de aprobación requieren una terminal interactiva y una identidad
humana responsable.

```bash
npm run ingest -- receive request <solicitud.yaml>
npm run ingest -- plan <change-id>
npm run ingest -- approve <change-id> --gate 1 --actor <persona-responsable>
npm run ingest -- generate <change-id> --adapter command
npm run ingest -- validate <change-id>
npm run ingest -- preview <change-id> --check-only
npm run ingest -- approve <change-id> --gate 2 --actor <persona-responsable>
npm run verify:ingestion
```

Antes de `generate`, el responsable debe haber configurado un
`INGEST_COMMAND_AGENT_CONFIG` revisado. Si no existe esa configuración, no la
inventes ni sustituyas por un comando arbitrario: detén el flujo.

La CLI actual termina en candidato aprobado y auditable. No contiene un
comando de publicación Cloudflare; `--execute` no habilita un deploy. Consulta
[la operación de ingestión](ingestion.md) para sus estados, límites y
recuperación.

Para probar los fixtures sin tocar producción:

```bash
INGEST_TEST_MODE=true npm run ingest:fixture
```

No uses `--record`, tags de fixture ni adaptadores reales como parte de una
prueba local ordinaria.

---

## 4. Habilitación inicial: repositorio y CI

Esta sección se realiza una sola vez por un administrador. No se considera
completada hasta que haya una entrega de preview validada.

### 4.1 Conectar el repositorio remoto

1. Añade el remoto desde el checkout local si todavía no está configurado:

   ```bash
   git remote add origin https://github.com/vbenhur-cs/webComunidadSolar.git
   git push -u origin main
   ```

2. Comprueba en el proveedor Git que se ha detectado
   [`.github/workflows/verify.yml`](../../.github/workflows/verify.yml).
   El workflow ejecuta tres jobs aislados de calidad, contratos/runtime y build
   independiente. El cuarto job publica el único check obligatorio
   `production-readiness`.

3. Protege `main` para exigir:

   - pull request obligatorio;
   - la comprobación `production-readiness` en verde y actualizada;
   - conversaciones resueltas e historial lineal;
   - bloqueo de eliminaciones y force-pushes.

   Mientras `vbenhur-cs` sea el único colaborador, la regla no exige una
   aprobación de PR para evitar un bloqueo circular. Al incorporar un segundo
   revisor, eleva el mínimo a una aprobación y exige que sea distinta del autor.

   Durante el bootstrap exige solo `production-readiness`. Después de una PR
   real validada, añade también `preview-approved`; nunca exijas un check antes
   de demostrar que el workflow puede producirlo.

Los workflows están separados por capacidad:

| Workflow | Evento | Puede hacer |
| --- | --- | --- |
| [`.github/workflows/verify.yml`](../../.github/workflows/verify.yml) | PR y push a `main` | Ejecutar CI sin secretos y emitir `production-readiness`. |
| [`.github/workflows/pr-preview.yml`](../../.github/workflows/pr-preview.yml) | `workflow_run` verde de una PR interna | Subir base/candidato, capturar, publicar evidencia y esperar `premerge-review`. |
| [`.github/workflows/shared-preview.yml`](../../.github/workflows/shared-preview.yml) | `workflow_run` verde de un push a `main` | Desplegar exactamente ese SHA a la preview compartida y registrar la release. |
| [`.github/workflows/production.yml`](../../.github/workflows/production.yml) | Manual | Fallar cerrado o, tras una habilitación futura, desplegar una versión productiva aprobada. |

### 4.2 Preparar Cloudflare y los perfiles externos

1. Mantén `comunidadsolar.es` y sus DNS en Raiola. El preview usa
   `workers.dev`, por lo que esta fase no requiere transferir el dominio ni
   cambiar nameservers.
2. En **Workers & Pages**, pulsa **Change** junto a **Your subdomain** y elige
   el subdominio global de la cuenta. Un Worker llamado
   `comunidad-solar-preview` quedará disponible como
   `https://comunidad-solar-preview.<subdominio-cuenta>.workers.dev`.
3. Crea o reutiliza un Account API Token limitado únicamente a esta cuenta,
   con `Workers Scripts: Write`, `D1: Edit` y `Workers KV Storage: Edit`.
   Astro genera el binding `SESSION` y Wrangler aprovisiona su namespace durante
   el primer despliegue. No necesita permisos DNS, Zone, R2, Billing ni gestión
   de tokens para el preview. Esos scopes cubren toda la cuenta, no solo los
   recursos de preview: usa un token distinto por entorno y, si se necesita
   aislamiento exigible por credencial, usa cuentas Cloudflare separadas.
4. Crea ahora solo los recursos de `preview`. La configuración de producción
   se prepara en una operación futura y nunca apunta al UUID cero de
   `wrangler.jsonc`.
5. Crea la base D1 de preview, preferiblemente con jurisdicción `eu`, y anota su
   nombre e ID en el gestor seguro del equipo, no en este repositorio.
6. Crea el perfil Wrangler de preview fuera del checkout. Debe declarar un
   único binding D1 llamado `DB`, el Worker, los assets, `drizzle` como
   directorio de migraciones y `SITE_INDEXABLE=false`. Debe usar el nombre
   `comunidad-solar-preview`, `workers_dev: true` y `preview_urls: true`.

7. Valida cada perfil antes de autorizar su uso. Con perfiles independientes
   no definas `CLOUDFLARE_ENV`; el nombre y el D1 del destino ya están fijados
   por cada archivo:

   ```bash
   CLOUDFLARE_CONFIG_PATH=/ruta-segura/comunidad-solar-preview.jsonc \
   npm run preview:cloudflare
   ```

   El comando genera una copia saneada en `.artifacts/config/`; revisa su hash
   y target, pero nunca imprimas ni compartas secretos.

8. Configura solo datos anonimizados de pruebas. Las calculadoras se mantienen
   como dominio externo y sus credenciales no entran en este repositorio.
9. No uses el preview público para rutas privadas ni datos personales. La
   adaptación a Cloudflare Access forma parte de la habilitación de producción.

La guía operativa de Cloudflare contiene la política del token, el ejemplo del
perfil y el procedimiento exacto para el subdominio:
[operación Cloudflare](cloudflare.md).

### 4.3 Preparar migraciones D1

Antes del primer Worker que use una base remota, revisa los SQL de `drizzle/`
y aplica las migraciones al entorno correspondiente. Usa el nombre real de la
base y el perfil externo, nunca el perfil local del repositorio:

```bash
npx wrangler d1 migrations list <nombre-base-preview> \
  --remote --config /ruta-segura/comunidad-solar-preview.jsonc

npx wrangler d1 migrations apply <nombre-base-preview> \
  --remote --config /ruta-segura/comunidad-solar-preview.jsonc
```

Haz primero preview. Para producción, repite el mismo proceso durante una
ventana aprobada y registra qué migraciones se aplicaron. Las migraciones de
datos deben ser compatibles hacia atrás con el Worker anterior: el rollback de
código no revierte por sí mismo una migración de base de datos.

Cloudflare documenta `wrangler d1 migrations list/apply` y realiza una copia de
seguridad al aplicar migraciones; consulta su
[referencia D1](https://developers.cloudflare.com/workers/wrangler/commands/d1/)
antes de cada operación sensible.

### 4.4 Activar el pipeline de preview una sola vez

El código del pipeline se fusiona primero sin exigir `preview-approved`, porque
un workflow `workflow_run` nuevo solo puede operar cuando ya está en la rama por
defecto.

1. Abre la PR bootstrap y espera `production-readiness`.
2. Guarda su número exacto en la variable de repositorio
   `PREVIEW_PIPELINE_BOOTSTRAP_PR` antes de fusionarla.
3. Fusiona el pipeline revisado. Su primer push a `main` reconoce la excepción y
   no intenta desplegar una solicitud web inexistente.
4. Configura el environment `preview` con dos variables y dos secrets, y crea
   `premerge-review` con el propietario como required reviewer. Mientras solo
   haya una persona, `prevent self-review` permanece desactivado.
5. Inicializa la rama huérfana `evidence` y bloquea eliminación y force-push,
   permitiendo commits append-only de GitHub Actions.
6. Elimina `PREVIEW_PIPELINE_BOOTSTRAP_PR`.
7. Ejecuta una PR real antes de añadir `preview-approved` a la protección de
   `main`.

Los nombres exactos y comandos de carga están en
[Configurar GitHub Actions para preview](cloudflare.md#configurar-github-actions-para-preview).
No inspecciones ni vuelques los valores después de cargarlos.

---

## 5. Procedimiento normal de un cambio web

### 5.1 Rama, contrato y pruebas

1. Parte de `main` actualizado y crea una rama descriptiva.
2. Implementa un solo cambio coherente. No incluyas migraciones `drizzle/` en
   el flujo web estándar: el resolver las rechaza.
3. Añade exactamente un contrato nuevo o modificado
   `evidence/requests/issue-<N>.yaml`. El número debe corresponder a una issue
   abierta y enlazada en la PR. Usa `scope: page` o `scope: section`; el segundo
   requiere un selector estable, preferiblemente
   `[data-evidence-id='nombre']`.
4. Ejecuta la matriz local de la sección 2 y corrige cualquier fallo.
5. Abre la PR con `Relates to #N`, no `Closes #N`: la issue debe permanecer
   abierta hasta el comentario de release.

### 5.2 CI, previews y evidencia

1. `verify.yml` ejecuta el código no confiable sin secrets. Si
   `production-readiness` falla, no se accede a Cloudflare.
2. `pr-preview.yml`, cargado desde `main`, vuelve a resolver la PR y rechaza
   forks, issues cerradas, SHAs cambiados, rutas privadas y contratos ambiguos.
3. El pipeline materializa el perfil desde el environment `preview`, pero
   compila el base y candidato en jobs separados sin credenciales.
4. El job con el token verifica bundles sellados y sube dos versiones exactas
   mediante `wrangler versions upload`. No mueve el deployment activo.
5. Un job sin secrets navega las URL HTTPS devueltas por Cloudflare, comprueba
   el status y captura desktop/móvil; `section` añade dos recortes.
6. GitHub Actions añade manifiestos y PNG bajo:

   ```text
   issue-N/baseline/<base-sha>/
   issue-N/candidates/<head-sha>/
   ```

   La rama `evidence` nunca sobrescribe una ruta existente. Repetir los mismos
   bytes es idempotente; una colisión distinta falla.
7. La PR y la issue reciben las dos Preview URLs, enlaces raw a las capturas,
   manifiestos, SHAs, versiones Cloudflare y ejecución GitHub.

Una PR desde un fork termina después del CI sin secretos. Para obtener preview,
un responsable debe trasladar el diff revisado a una rama interna.

### 5.3 Aprobación, corrección y merge

1. Abre el deployment pendiente del environment `premerge-review`.
2. Compara base y candidata, página completa y sección cuando aplique, en móvil
   y escritorio. Verifica también contenido, enlaces, accesibilidad y criterios
   de la issue.
3. Si hay una corrección, no apruebes. Añade un commit a la PR. El SHA nuevo
   invalida el estado anterior y debe producir previews, PNG y aprobación nueva.
4. Si todo es correcto, aprueba el environment. El último job vuelve a consultar
   que el head no cambió y emite `preview-approved` solo para ese SHA.
5. Fusiona únicamente cuando `production-readiness` y `preview-approved` estén
   verdes, las conversaciones resueltas y la protección de rama satisfecha.

Cerrar la PR antes del merge es un rollback completo: las versiones aisladas no
han cambiado `main` ni la preview compartida.

### 5.4 Release automática a la preview compartida

El push integrado a `main` inicia otro `Production readiness`. Si termina en
verde, `shared-preview.yml`:

1. fija el SHA exacto de `main` y localiza la única PR integrada;
2. verifica su issue, contrato y aprobación;
3. reconstruye y sella ese SHA sin secrets;
4. vuelve a comprobar `main` justo antes del upload;
5. sube una versión y la despliega al 100 % en
   `comunidad-solar-preview`;
6. hace smoke test y captura la ruta en la URL compartida; y
7. añade evidencia inmutable bajo `issue-N/releases/<main-sha>/` y comenta PR e
   issue.

Comprueba el comentario de release y la respuesta pública:

```bash
curl -fIs https://comunidad-solar-preview.comunidadsolar-dev.workers.dev/
```

Solo entonces se cierra la issue. Esta release sigue siendo no indexable y no
toca Raiola, DNS ni `comunidadsolar.es`.

---

## 6. Producción: implementada pero deshabilitada

El workflow `.github/workflows/production.yml` se inicia manualmente con un SHA
de `main`, pero antes de usar cualquier credencial exige que
`PRODUCTION_ENABLED` sea exactamente `true`. Durante el bootstrap esa variable
está ausente o es `false`, y el environment `production` queda sin credenciales.

### 6.1 Prerrequisitos para una habilitación futura

Una revisión operativa separada debe confirmar todos estos puntos:

- dominio, DNS y ventana de cambio aprobados;
- Worker fijo `comunidad-solar-production` con Preview URLs desactivadas;
- D1 fija `comunidad-solar-production`, migraciones revisadas y datos separados;
- perfil externo con `SITE_INDEXABLE=true` y sin rutas de preview;
- Cloudflare Access y la identidad de rutas privadas adaptados y probados;
- token de producción distinto al de preview y con mínimo privilegio;
- environment `production` con required reviewers; y
- un deployment anterior conocido, necesario para construir un descriptor de
  rollback verificable. El primer aprovisionamiento se realiza en un cambio
  manual revisado, no fingiendo que existe una versión anterior.

Solo entonces se cargan, por canales seguros:

| Tipo | Nombre |
| --- | --- |
| variable | `PRODUCTION_ENABLED=true` |
| variable | `CLOUDFLARE_PRODUCTION_ACCOUNT_ID` |
| variable | `CLOUDFLARE_PRODUCTION_URL` |
| secret | `CLOUDFLARE_PRODUCTION_API_TOKEN` |
| secret | `CLOUDFLARE_PRODUCTION_CONFIG_B64` |

La URL debe ser el origen HTTPS exacto configurado. El workflow rechaza la URL
de preview, `workers.dev`, `comunidadsolar.es` codificado en el código o
cualquier origen diferente al autorizado.

### 6.2 Ejecución futura

Después de aprobar el release SHA y su evidencia compartida:

```bash
gh workflow run production.yml --ref main -f sha=<SHA_MAIN_APROBADO>
```

El environment pausa la autorización. El workflow exige una PR interna
integrada, una única issue/solicitud, la evidencia de release canónica y el
último status `preview-approved` exitoso con una URL de GitHub Actions. Rechaza
cambios `drizzle/`. Luego construye el SHA exacto, verifica el bundle, consulta
el deployment anterior, sube una versión sin alias preview, despliega ese UUID
al 100 %, hace smoke test y publica un manifiesto bajo
`issue-N/production/<sha>/manifest.json`.

El job de despliegue conserva durante 90 días un artifact saneado de rollback
con las versiones anteriores y nueva, deployments, SHA y run URL. No contiene
tokens ni bytes del perfil original.

---

## 7. Incidente y reversión

### Antes del merge

Cierra la PR o solicita correcciones. Las Preview URLs aisladas pueden quedar
como artefactos temporales, pero no han movido ninguna versión compartida.

### Después del merge en `main`

Crea una rama desde `main`, ejecuta `git revert <sha>` y abre una PR nueva con
su propia issue/contrato cuando corresponda. Repite CI, previews, evidencia y
aprobación. No uses force-push ni reescribas historial.

### Después de desplegar un Worker

Identifica el deployment anterior en el descriptor de rollback y promueve sus
versiones exactas mediante el procedimiento Cloudflare aprobado. Registra actor,
motivo, hora, deployment/version IDs y resultado del smoke test. Después crea
la PR correctiva para que Git y Cloudflare vuelvan a converger.

Un rollback de Worker no deshace D1 ni KV. No reviertas migraciones
automáticamente: evalúa compatibilidad, backup y una migración correctiva.

Si CI, captura o smoke falla, detén la promoción, conserva run URL, SHA y
mensajes saneados y abre un incidente. No reintentes a ciegas ni borres la
evidencia del fallo.

## 8. Lista de comprobación rápida

Para una release a preview compartida:

- [ ] La issue continúa abierta y tiene aprobador, ruta y criterios.
- [ ] La PR interna contiene un único contrato de evidencia válido.
- [ ] La matriz local y `production-readiness` están verdes.
- [ ] Existen previews base/candidata y PNG válidos en `evidence`.
- [ ] `premerge-review` aprobó el SHA head actual.
- [ ] `preview-approved` pertenece a ese SHA.
- [ ] El merge disparó la release del SHA de `main`.
- [ ] El comentario final contiene URL, manifest, capturas y run.
- [ ] `comunidadsolar.es`, DNS, Raiola y producción no cambiaron.

Para una futura release productiva, añade todos los prerrequisitos de 6.1,
smoke test, descriptor de rollback y evidencia del environment protegido.

## Referencias

- [Solicitar cambios en la web](web-change-requests.md)
- [Operación Cloudflare del proyecto](cloudflare.md)
- [Operación de ingestión de páginas](ingestion.md)
- [Aislamiento de agentes](agent-isolation.md)
- [Comandos de Wrangler para Workers](https://developers.cloudflare.com/workers/wrangler/commands/workers/)
- [CI/CD de Cloudflare Workers](https://developers.cloudflare.com/workers/ci-cd/)
