# Runbook de pruebas, despliegue y cambios en producción

Este documento explica cómo preparar, probar y publicar Comunidad Solar Astro
en Cloudflare Workers. Está dirigido a la persona responsable de una entrega y
separa con claridad los procedimientos que ya se pueden ejecutar de los que
requieren habilitar la publicación real por primera vez.

## Estado y regla principal

El repositorio ya dispone de:

- una CLI para recibir, generar y validar páginas con dos aprobaciones humanas;
- comprobaciones locales y un workflow de GitHub Actions con un gate estable
  `production-readiness`;
- una build de Astro para Cloudflare Workers y `npm run deploy:dry`.

Cloudflare Workers es el destino de alojamiento aprobado. La evaluación de
Raiola queda cerrada mientras la aplicación dependa del adaptador Cloudflare,
D1, bindings de Workers y el publicador Cloudflare. Esta decisión no habilita
por sí misma un despliegue.

No dispone todavía de un despliegue real automatizado. `deploy:dry` **no usa
red ni ejecuta `wrangler deploy`**. El `wrangler.jsonc` versionado contiene una
base D1 local y no debe emplearse para producción.

Por tanto, no ejecutes una publicación real hasta haber completado la sección
«Habilitación inicial». Una vez habilitado el pipeline, el despliegue de
producción debe hacerse únicamente desde el job protegido de CI; no desde un
ordenador personal salvo un incidente aprobado.

## Responsabilidades mínimas

| Rol | Responsabilidad |
| --- | --- |
| Autor del cambio | Crea la rama, ejecuta las pruebas locales y abre la PR. |
| Revisor | Revisa código/contenido, resultados de CI y el impacto de datos. |
| Responsable de release | Aprueba el entorno `production`, comprueba el smoke test y registra la entrega. |
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
- `deploy:dry` prepara un perfil local saneado, construye y verifica la
  topología emitida. No publica nada.

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

El workflow actual es CI, no CD: valida cambios pero no despliega.

### 4.2 Preparar Cloudflare y los perfiles externos

1. Mantén `comunidadsolar.es` y sus DNS en Raiola. El preview usa
   `workers.dev`, por lo que esta fase no requiere transferir el dominio ni
   cambiar nameservers.
2. En **Workers & Pages**, pulsa **Change** junto a **Your subdomain** y elige
   el subdominio global de la cuenta. Un Worker llamado
   `comunidad-solar-preview` quedará disponible como
   `https://comunidad-solar-preview.<subdominio-cuenta>.workers.dev`.
3. Crea o reutiliza un Account API Token limitado únicamente a esta cuenta,
   con `Workers Scripts: Write` y `D1: Edit`. No necesita permisos DNS, Zone,
   KV, R2, Billing ni gestión de tokens para el preview.
4. Crea recursos separados para `preview` y `production`; nunca apuntes la
   producción al UUID cero de `wrangler.jsonc`.
5. Crea una base D1 por entorno, preferiblemente con jurisdicción `eu`, y anota
   sus nombres e IDs en el gestor seguro del equipo, no en este repositorio.
6. Crea un perfil Wrangler por entorno fuera del checkout. Debe declarar un
   único binding D1 llamado `DB`, el Worker, los assets, `drizzle` como
   directorio de migraciones y el valor correcto de `SITE_INDEXABLE`:

   - preview: `false`;
   - producción: `true`, solamente cuando dominio, robots y sitemap estén
     listos para indexarse.

   El perfil de preview debe usar además el nombre
   `comunidad-solar-preview`, `workers_dev: true` y `preview_urls: true`.

7. Valida cada perfil antes de autorizar su uso. Con perfiles independientes
   no definas `CLOUDFLARE_ENV`; el nombre y el D1 del destino ya están fijados
   por cada archivo:

   ```bash
   CLOUDFLARE_CONFIG_PATH=/ruta-segura/comunidad-solar-preview.jsonc \
   npm run preview:cloudflare
   ```

   Repite con el perfil de producción. El comando genera una copia saneada en
   `.artifacts/config/`; revisa su hash y target, pero nunca imprimas ni
   compartas secretos.

8. Configura los bindings y datos operativos desde el almacén de secretos de
   Cloudflare o desde secretos del entorno de CI. Mantén deshabilitado cualquier
   quoting que vaya a vivir en un dominio externo hasta que su integración esté
   aprobada.
9. Adapta las cuatro rutas privadas a Cloudflare Access. El código actual lee
   cabeceras `oai-authenticated-user-*`; producción debe consumir una identidad
   verificada de Access y conservar las allowlists por área.

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

### 4.4 Crear el job de despliegue protegido

Este paso todavía requiere implementación y revisión; no cambies
`verify.yml` para que publique directamente. Crea un workflow de despliegue
independiente con esta topología:

```text
PR → verify.yml → revisión humana → merge en main
                                      │
                                      ▼
                               deploy preview
                                      │
                                      ▼
                          aprobación del entorno production
                                      │
                                      ▼
                             deploy producción + smoke test
```

El workflow futuro debe cumplir todo lo siguiente:

1. Ejecutar el mismo SHA que superó CI; no reconstruir una rama distinta.
2. Desplegar primero a preview con el perfil externo de preview.
3. Exigir el entorno protegido `production` y un aprobador distinto del autor
   para el paso productivo.
4. Guardar `CLOUDFLARE_ACCOUNT_ID` como variable y
   `CLOUDFLARE_API_TOKEN` como secret del environment de GitHub, separados
   entre preview y producción. El token debe estar limitado a la cuenta con
   `Workers Scripts: Write` y `D1: Edit`.
5. Materializar el perfil externo en el directorio temporal del runner, no en
   el repositorio ni en los logs.
6. Ejecutar, en orden: validación del perfil, pruebas, migraciones revisadas,
   `wrangler deploy` con el perfil exacto y smoke tests.
7. Registrar SHA, URL de ejecución, versión del Worker, hash del perfil
   saneado, migraciones aplicadas y resultado del smoke test como evidencia de
   release.

La autenticación de Workers desde GitHub Actions requiere una cuenta y un API
token de Cloudflare almacenados como secretos; la guía oficial describe el
alcance mínimo y un ejemplo de workflow:
[GitHub Actions para Workers](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).

---

## 5. Procedimiento de una entrega a producción

Una vez habilitada la sección anterior, sigue este orden para cada cambio.

1. **Crear la rama.** Parte de `main` actualizado, usa un nombre descriptivo y
   limita la rama a un cambio coherente.
2. **Validar localmente.** Ejecuta la sección 2. Si el cambio afecta rutas,
   interfaz, datos o autenticación, añade `npm run verify:public`.
3. **Abrir PR.** Incluye impacto, estrategia de reversión, migraciones y rutas
   que deben comprobarse después del deploy.
4. **Esperar CI.** La PR no se aprueba mientras `production-readiness` no
   esté en verde.
5. **Revisión humana.** El revisor confirma el diff, la evidencia de pruebas y
   que no hay secretos ni configuración productiva versionados.
6. **Fusionar en `main`.** Solo después de CI y revisión. El SHA fusionado es
   el único candidato de release.
7. **Desplegar preview.** El workflow protegido crea/actualiza preview con ese
   SHA. Comprueba las rutas críticas y el comportamiento de base de datos con
   datos no sensibles.
8. **Aprobar producción.** El responsable de release revisa preview, el hash
   de configuración saneada y las migraciones. A continuación aprueba el
   entorno `production` en GitHub.
9. **Desplegar producción.** El job ejecuta el deploy del mismo SHA y publica
   sus metadatos de versión.
10. **Hacer smoke test.** Comprueba como mínimo:

    ```bash
    curl -fIs https://<dominio-produccion>/
    curl -fIs https://<dominio-produccion>/robots.txt
    curl -fIs https://<dominio-produccion>/sitemap.xml
    ```

    Añade las rutas funcionales y privadas afectadas por la entrega, siempre
    con cuentas de prueba autorizadas y sin incluir datos personales en los
    logs.
11. **Cerrar la release.** Registra el SHA, hora, versión Cloudflare, URLs
    comprobadas, resultado de migraciones, responsable y cualquier incidencia.

## 6. Incidente y reversión

Si falla CI, preview o el smoke test de producción:

1. Detén la promoción. No relances el deploy a ciegas.
2. Conserva el enlace al job, SHA, versión del Worker, mensajes saneados y el
   estado de migraciones.
3. Si el problema solo afecta al Worker, vuelve a la versión de Worker previa
   mediante el procedimiento aprobado de Cloudflare. No reutilices una versión
   sin identificarla explícitamente.
4. Si ya se aplicó una migración D1, no la reviertas automáticamente. Evalúa
   compatibilidad, copia de seguridad y una migración correctiva revisada.
5. Abre un incidente para el responsable de release y el administrador
   Cloudflare; comunica alcance, estado de usuarios y siguiente actualización.
6. Después del incidente, añade una prueba de regresión o ajusta este runbook
   antes de volver a promocionar.

## 7. Lista de comprobación rápida

Antes de liberar, el responsable confirma:

- [ ] El árbol de trabajo está limpio y la entrega parte de `main` actualizado.
- [ ] La secuencia local completa terminó en verde.
- [ ] La PR tiene CI verde y revisión humana.
- [ ] El perfil Cloudflare externo apunta al entorno correcto y ha sido validado.
- [ ] Las migraciones D1 están revisadas y son compatibles con rollback.
- [ ] Preview se ha comprobado con el mismo SHA.
- [ ] La aprobación de producción procede de un responsable autorizado.
- [ ] El smoke test de producción, la evidencia y el plan de reversión están registrados.

## Referencias

- [Operación Cloudflare del proyecto](cloudflare.md)
- [Operación de ingestión de páginas](ingestion.md)
- [Aislamiento de agentes](agent-isolation.md)
- [Comandos de Wrangler para Workers](https://developers.cloudflare.com/workers/wrangler/commands/workers/)
- [CI/CD de Cloudflare Workers](https://developers.cloudflare.com/workers/ci-cd/)
