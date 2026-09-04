# Diseño del pipeline de preview, evidencia y aprobación de cambios web

Estado: diseño aprobado e implementación completada en la rama del pipeline el
4 de septiembre de 2026. La activación externa se realiza mediante el bootstrap
seguro descrito en la sección 17 y se considera validada solo tras la prueba
real de la issue #4.

## 1. Resultado buscado

Cada cambio web solicitado mediante una issue debe poder recorrer un flujo
reproducible antes de llegar a producción:

```text
issue + contrato de evidencia
          |
          v
Pull Request -> CI existente en verde
          |
          v
preview exacta del base + preview exacta del candidato
          |
          v
pruebas operativas + capturas PNG desktop/móvil
          |
          v
evidencia permanente en la rama evidence
          |
          v
aprobación humana en premerge-review
          |
          v
merge a main -> despliegue del mismo SHA a preview compartida
          |
          v
producción manual, bloqueada hasta completar su habilitación
```

El pipeline debe permitir comparar el antes y el después, impedir que una
captura fallida se presente como aprobación, vincular cada decisión a commits
exactos y conservar una ruta de rollback. La primera implementación no cambia
DNS, no toca `comunidadsolar.es`, no publica en producción y utiliza únicamente
el entorno gratuito `workers.dev` ya creado.

## 2. Decisiones vinculantes

1. Cada PR de cambio web tendrá un contrato versionado
   `evidence/requests/issue-<N>.yaml`.
2. Se publicarán dos versiones aisladas del Worker de preview: una para el SHA
   base exacto de la PR y otra para su SHA candidato exacto.
3. Ninguna de esas versiones sustituirá el despliegue activo de la preview
   compartida.
4. Toda solicitud capturará la página completa en escritorio y móvil.
5. Una solicitud de alcance `section` capturará además el selector declarado
   en escritorio y móvil.
6. Las capturas serán PNG generados por Chromium mediante Playwright sobre las
   URLs reales de Cloudflare, no imágenes simuladas ni screenshots del build
   local.
7. La evidencia durable vivirá en una rama Git dedicada llamada `evidence`.
   Una ruta existente nunca se sobrescribirá ni se eliminará.
8. Una captura, comprobación o publicación de evidencia fallida bloqueará la
   aprobación.
9. La aprobación humana ocurrirá después de disponer de previews operativas y
   evidencia, mediante el environment protegido `premerge-review`.
10. Mientras exista una sola persona responsable, el environment admitirá su
    propia aprobación. Cuando exista un segundo revisor, se activará la regla
    que impide al autor aprobar su propio despliegue.
11. Tras el merge, el SHA exacto de `main` se desplegará al Worker compartido de
    preview y se volverá a capturar como evidencia de release.
12. Producción permanecerá cerrada mediante una condición explícita y un
    environment separado hasta completar dominio, D1, Access, credenciales y
    aprobación de release.

## 3. Alcance y exclusiones

### Incluido

- validación del contrato de cambio asociado a la issue;
- CI actual como condición previa;
- compilación sin credenciales del base y el candidato;
- carga de versiones y creación de Preview URLs de Cloudflare;
- smoke tests HTTP y navegador sobre ambas versiones;
- capturas full-page y, cuando corresponda, de sección;
- manifiestos con hashes, dimensiones, SHAs, URLs y versiones de herramientas;
- almacenamiento append-only en la rama `evidence`;
- comentarios trazables en la PR y en la issue;
- aprobación humana previa al merge;
- despliegue automático del SHA integrado a la preview compartida;
- documentación de configuración, operación y rollback; y
- pruebas unitarias y de contrato del propio pipeline.

### Excluido en esta entrega

- cambios en Raiola, DNS, nameservers o `comunidadsolar.es`;
- un despliegue real a producción;
- copiar datos de producción a preview;
- ejecutar migraciones D1 automáticamente desde una PR;
- previews de rutas privadas o con datos personales;
- aceptar previews privilegiadas desde forks; y
- prometer que una Preview URL seguirá disponible indefinidamente. La evidencia
  PNG y sus manifiestos sí serán permanentes en Git.

Una PR que cambie `drizzle/`, bindings o requisitos de datos fallará cerrada en
el flujo estándar. Necesitará un plan de migración independiente, compatible
hacia atrás y aprobado antes de volver a habilitar la preview.

## 4. Modelo de confianza

### 4.1 Código de PR

El código y los scripts del candidato no reciben `CLOUDFLARE_API_TOKEN`,
credenciales de GitHub con escritura, secretos de runtime ni configuración de
producción. Se instalan y compilan en un job con permisos de solo lectura y
`actions/checkout` sin credenciales persistentes.

Solo se aceptan PR internas del mismo repositorio para el despliegue
automático. Una PR desde un fork conserva el CI sin secretos, pero el check
`preview-approved` no se emitirá y el merge quedará bloqueado hasta que una
persona autorizada traslade el cambio a una rama interna revisada.

### 4.2 Workflow privilegiado

La publicación se ejecuta desde un workflow `workflow_run` presente en la rama
por defecto. Por tanto, la definición que recibe secretos procede de `main`, no
de la rama candidata. El workflow:

1. acepta solo una ejecución exitosa de `Production readiness` originada por
   `pull_request`;
2. resuelve la PR mediante la API de GitHub y vuelve a comprobar repositorio,
   base, head, estado y SHAs;
3. prepara artefactos en jobs sin secretos;
4. entrega el token Cloudflare únicamente al job que ejecuta Wrangler;
5. no ejecuta scripts, binarios ni configuración aportados por el artefacto en
   ese job; y
6. usa scripts de control obtenidos del SHA confiable de `main`.

No se utilizará `pull_request_target` para ejecutar, compilar, probar o navegar
el código candidato.

### 4.3 Separación de capacidades

Las capacidades se dividen por job:

| Job | Código candidato | Token Cloudflare | GitHub write | Navega preview |
| --- | --- | --- | --- | --- |
| Resolver contexto | No | No | No | No |
| Build base/candidato | Sí | No | No | No |
| Subir versiones | No | Sí | No | No |
| Capturar y probar | Solo remoto | No | No | Sí |
| Publicar evidencia/comentar | No | No | Sí | No |
| Aprobar | No | No | `statuses: write` | No |

La preview no contendrá secretos ni datos reales. La base D1 de preview será
exclusiva de pruebas y solo contendrá fixtures públicos o anonimizados.

## 5. Contrato de solicitud de evidencia

Cada PR funcional añade exactamente un archivo nuevo bajo
`evidence/requests/`. Su forma canónica será:

```yaml
schema_version: 1
issue: 4
scope: page
route: /pruebas/guia-comunidades-propietarios
expected_status:
  base: 404
  candidate: 200
viewports:
  - desktop
  - mobile
```

Para una sección:

```yaml
schema_version: 1
issue: 5
scope: section
route: /autoconsumo-remoto
selector: "[data-evidence-id='beneficios']"
expected_status:
  base: 200
  candidate: 200
viewports:
  - desktop
  - mobile
```

Reglas:

- el nombre y el campo `issue` deben coincidir;
- `issue` es un entero positivo y debe identificar una issue abierta;
- `scope` solo admite `page` o `section`;
- `route` es el path local canónico del sitio: `/` para portada y sin barra
  final para el resto, además de no admitir origen, query, fragmento,
  traversal ni caracteres de control;
- las rutas privadas y endpoints API quedan prohibidos en la primera versión;
- `selector` es obligatorio solo para `section`, tiene longitud limitada y no
  admite expresiones que ejecuten código;
- los viewports son exactamente `desktop` y `mobile` en ese orden;
- los estados HTTP válidos se limitan a los definidos por el schema; y
- no se aceptan campos desconocidos.

El pipeline comprobará que el archivo fue añadido o modificado en la PR actual
y que la issue esté enlazada en el cuerpo de la PR. Una PR técnica que solo
modifique el propio pipeline podrá declarar una exención bootstrap explícita;
esa excepción desaparece de la protección de `main` una vez completada la
primera prueba real.

## 6. Identidad de las versiones Cloudflare

El Worker seguirá llamándose `comunidad-solar-preview`. Cada artefacto se
subirá con `wrangler versions upload`, nunca con `wrangler deploy`, durante una
PR. La versión registrará:

- número de PR;
- rol `base` o `candidate`;
- SHA Git completo;
- SHA-256 del bundle verificado; y
- ID de la ejecución GitHub.

Cada versión recibirá un alias corto, normalizado y único para el SHA, por
ejemplo `pr-4-base-fd93f18` y `pr-4-head-a1b2c3d`. La URL devuelta por
Cloudflare será la única fuente de la URL a capturar; no se construirá mediante
concatenación no verificada.

Antes de usarla se comprobará que sea HTTPS, no contenga credenciales ni puerto
y termine en `.workers.dev`. La URL se combinará únicamente con el `route`
normalizado del contrato.

## 7. Construcción y publicación de artefactos

### 7.1 Preparación

Un job confiable materializa el perfil externo de preview desde un secret del
environment `preview`, lo valida con la política existente y produce solo su
proyección saneada. El fichero original no se imprime, no se adjunta y se borra
al terminar.

La proyección saneada puede viajar a los jobs de build porque no contiene
credenciales. Incluye el nombre del Worker, bindings de preview, UUID D1 de
preview e indexabilidad `false`.

### 7.2 Build sin autoridad

Base y candidato se obtienen por SHA completo en directorios separados. Para
cada uno se ejecuta `npm ci`, la build con el perfil saneado y la verificación
de output ya existente. El resultado se empaqueta con:

- inventario cerrado de archivos regulares;
- modo, tamaño y SHA-256 de cada archivo;
- SHA del source;
- versión de Node, npm, Astro y Wrangler; y
- hash del perfil saneado.

Se rechazan symlinks, archivos especiales, paths escapados, ficheros de entorno,
credenciales, tamaños fuera de límite o una topología distinta de la aprobada.

### 7.3 Upload privilegiado

El job de upload usa un checkout limpio del controlador desde `main`, instala
el lockfile confiable y descarga los dos bundles. Vuelve a validar inventario,
hashes y topología antes de invocar Wrangler mediante argv fijo. No ejecuta
`npm` dentro de los bundles ni importa módulos del candidato.

El token se limita a la cuenta de preview y nunca se comparte con producción.
El job devuelve solo descriptores saneados: rol, SHA, digest, ID de versión y
Preview URL.

## 8. Captura y pruebas operativas

Un job sin secretos abre las dos URLs con Chromium. Para cada variante y
viewport:

1. solicita la ruta y comprueba el status esperado;
2. espera `DOMContentLoaded`, `document.fonts.ready` y un periodo estable
   acotado;
3. comprueba que existe un documento visible y que no hubo errores de página;
4. fija color scheme, locale, timezone, animaciones y motion para reducir
   variabilidad;
5. captura la página completa; y
6. si `scope` es `section`, exige un único elemento visible para el selector y
   captura ese elemento.

Viewports iniciales:

| Nombre | Tamaño CSS | Device scale factor |
| --- | --- | --- |
| desktop | 1440 x 1000 | 1 |
| mobile | 390 x 844 | 1 |

Los nombres canónicos son:

```text
before-desktop.png
before-mobile.png
after-desktop.png
after-mobile.png
before-section-desktop.png
before-section-mobile.png
after-section-desktop.png
after-section-mobile.png
```

Se aplicarán límites de duración, altura, dimensiones, cantidad y tamaño total.
Una página que exceda los límites falla con una explicación; nunca se recorta
silenciosamente ni se guarda una imagen parcial como full-page.

## 9. Evidencia durable

La rama `evidence` será huérfana respecto a `main` y tendrá esta estructura:

```text
README.md
issue-<N>/
├── baseline/<base-sha>/
│   ├── before-desktop.png
│   ├── before-mobile.png
│   ├── before-section-desktop.png      # solo section
│   ├── before-section-mobile.png       # solo section
│   └── manifest.json
├── candidates/<head-sha>/
│   ├── after-desktop.png
│   ├── after-mobile.png
│   ├── after-section-desktop.png       # solo section
│   ├── after-section-mobile.png        # solo section
│   └── manifest.json
└── releases/<main-sha>/
    ├── release-desktop.png
    ├── release-mobile.png
    ├── release-section-desktop.png     # solo section
    ├── release-section-mobile.png      # solo section
    └── manifest.json
```

Cada manifiesto incluirá:

- schema y tipo de evidencia;
- issue, PR y route;
- SHA base, candidato o release, según corresponda;
- URL y origen Cloudflare saneados;
- ID de versión Worker;
- fecha UTC de la primera captura;
- browser, Playwright, Node y viewport;
- selector cuando aplique;
- status HTTP y comprobaciones operativas;
- nombre, bytes, dimensiones y SHA-256 de cada PNG; y
- run ID y URL de la ejecución GitHub.

El writer usa concurrencia global para la rama. Antes de publicar, obtiene el
head remoto más reciente, rechaza deletes/renames y comprueba cada destino:

- si no existe, añade los archivos en un único commit;
- si existe y todos los bytes/hashes estables coinciden, trata el reintento
  como idempotente y conserva la fecha original; y
- si existe con contenido diferente, falla sin sobrescribir.

No se permite force-push. La rama tendrá una regla de protección contra
eliminación y reescritura. Los PNG y manifiestos no contendrán datos personales,
tokens, cookies, cabeceras privadas ni contenido de rutas protegidas.

## 10. Comentarios en GitHub

Tras publicar la evidencia, el workflow crea o actualiza un comentario
identificado por marcador tanto en la PR como en la issue. El comentario
contendrá:

- SHAs completos del base y candidato;
- enlaces a ambas Preview URLs;
- thumbnails/enlaces raw de las capturas;
- enlace al manifiesto y al commit de la rama `evidence`;
- resultado de las comprobaciones; y
- instrucción inequívoca para aprobar o solicitar correcciones.

El comentario no declara que el cambio esté aprobado. Si se vuelve a ejecutar
el mismo SHA se actualiza su comentario marcado y no se genera spam. Un SHA
nuevo crea una nueva identidad de evidencia y requiere otra aprobación.

## 11. Gate humano y protección de `main`

Después de la evidencia, un job entra en el environment
`premerge-review`. GitHub pausará el job hasta que la persona configurada revise
las capturas y ambas URLs. La aprobación del environment autoriza únicamente a
emitir el commit status `preview-approved` sobre el SHA candidato exacto.

La protección de `main` exigirá simultáneamente:

- `production-readiness`;
- `preview-approved`;
- PR obligatoria;
- conversaciones resueltas;
- historial lineal; y
- bloqueo de force-push y eliminación.

La primera configuración permitirá que la única persona responsable apruebe su
propia ejecución. Al añadir un segundo revisor se habilitarán una aprobación
mínima de PR y `prevent self-review` en el environment.

Un push nuevo invalida de hecho la aprobación porque cambia el SHA y el status
requerido deja de existir para el nuevo head. Cerrar la PR evita cualquier
merge y es el rollback anterior a integración.

## 12. Despliegue a preview compartida después del merge

Una ejecución exitosa de `Production readiness` para un push a `main` activa
otro camino del workflow confiable. Este camino:

1. fija `workflow_run.head_sha` como release SHA;
2. verifica que pertenece a `main` y localiza la PR integrada;
3. reconstruye y valida ese SHA sin secretos;
4. despliega exactamente su bundle al Worker compartido
   `comunidad-solar-preview`;
5. ejecuta smoke tests sobre
   `https://comunidad-solar-preview.comunidadsolar-dev.workers.dev`;
6. captura las rutas declaradas por el contrato; y
7. añade evidencia append-only bajo `releases/<main-sha>/` y comenta issue/PR.

Este paso puede cambiar únicamente la preview compartida. No cambia DNS ni
activa indexación. El perfil debe conservar `SITE_INDEXABLE=false`.

## 13. Producción y rollback

### 13.1 Producción bloqueada

El workflow de producción será manual y fallará cerrado mientras
`PRODUCTION_ENABLED` no sea exactamente `true`. Además requerirá:

- environment protegido `production`;
- token y Account ID distintos de preview;
- perfil de producción validado e indexable de forma explícita;
- dominio y Access configurados;
- D1 de producción y migraciones revisadas;
- SHA de `main` con evidencia de release aprobada; y
- aprobación del responsable de release.

No se habilitará esa variable ni se introducirán esos secretos en esta entrega.

### 13.2 Rollback

- **Antes del merge:** cerrar la PR. El status de preview no mueve `main`.
- **Después del merge:** crear `git revert <sha>` en una PR nueva y repetir
  CI, preview, evidencia y aprobación. No se reescribe historial.
- **Después de desplegar un Worker:** volver a una versión Cloudflare conocida
  y registrar versión, actor y motivo; después crear la PR de corrección.
- **D1/KV:** un rollback de Worker no revierte migraciones ni datos. Toda
  migración deberá ser compatible con la versión anterior o tener un plan de
  recuperación separado.

## 14. Workflows y componentes previstos

```text
.github/workflows/verify.yml
  - conserva CI sin secretos
  - publica el bundle candidato verificable como artefacto cuando corresponda

.github/workflows/pr-preview.yml
  - workflow_run confiable para PR
  - resuelve contexto, prepara builds, sube versiones, captura, escribe
    evidencia, comenta y espera premerge-review

.github/workflows/shared-preview.yml
  - workflow_run confiable para push verde en main
  - despliega el SHA exacto a la preview compartida y captura release

.github/workflows/production.yml
  - workflow_dispatch manual y fail-closed hasta habilitación expresa

scripts/preview-evidence/
  - schema y parser del request
  - resolución segura del contexto GitHub
  - inventario y verificación de bundles
  - parser estricto de resultados Wrangler
  - captura Playwright y manifiestos
  - writer append-only y comentarios
  - verificación de elegibilidad para release

tests/preview-evidence/
  - pruebas unitarias, de seguridad, fixtures y contratos de workflow
```

Los nombres concretos podrán agruparse durante el plan de implementación, pero
no se combinarán capacidades que esta especificación separa.

## 15. Manejo de errores

- CI fallido: no se inicia publicación.
- PR ausente, cerrada, de fork o SHA inconsistente: no se obtiene token ni se
  emite aprobación.
- Contrato ausente o inválido: check fallido con error accionable.
- Issue inexistente/cerrada o no enlazada: check fallido.
- Perfil preview inválido o con indexación: fallo antes de Wrangler.
- Build o bundle inválido: no se carga ninguna versión de ese rol.
- Respuesta Wrangler ambigua o URL fuera de `workers.dev`: no se navega.
- Status HTTP distinto, error de browser o selector inválido: no se publica
  evidencia aprobable.
- PNG excesivo, truncado o inválido: fallo de captura.
- Colisión en `evidence`: fallo sin sobrescritura.
- Comentario GitHub fallido: no se solicita aprobación.
- Environment no aprobado: status `preview-approved` ausente.
- Head de PR cambiado durante el proceso: el workflow termina sin aprobar el
  SHA nuevo.
- Preview compartida fallida tras merge: producción sigue bloqueada y se
  conserva la versión anterior para rollback.

Los logs se limitarán a identificadores, hashes, rutas públicas y categorías de
error. Nunca imprimirán tokens, perfiles originales, cookies, cuerpos privados
ni variables completas de entorno.

## 16. Estrategia de pruebas

La implementación se desarrollará test-first y deberá demostrar:

- schema cerrado y normalización determinista del request;
- rechazo de paths, selectores, rutas privadas y campos desconocidos;
- resolución exacta de PR/base/head y rechazo de forks o carreras de SHA;
- workflow privilegiado disparado solo desde el workflow confiable y exitoso;
- ausencia de secretos en jobs que ejecutan candidato o Chromium;
- inventarios deterministas, límites y rechazo de symlinks/especiales;
- parseo estricto de la salida real de Wrangler fijada en el lockfile;
- validación de origen `.workers.dev`;
- screenshots full-page y de sección con PNG/dimensiones/hashes comprobados;
- manifiestos canónicos e idempotencia append-only;
- rechazo de sobrescritura y de colisiones concurrentes;
- comentarios sin secretos y vinculados al SHA;
- status `preview-approved` únicamente después de evidence + environment;
- despliegue post-merge ligado al SHA de `main`;
- producción bloqueada por defecto; y
- continuidad de las 731 pruebas de línea base, format, lint, check, build,
  runtime contracts e independent build.

Habrá además un ensayo real de extremo a extremo con la issue #4 una vez que el
pipeline bootstrap esté integrado en `main`. El ensayo creará una PR separada,
capturará la ruta nueva con base 404 y candidato 200, solicitará aprobación y
solo entonces permitirá integrarla.

## 17. Bootstrap y activación segura

Un workflow `workflow_run` nuevo solo puede ejecutarse desde la rama por
defecto. Por ello la activación se hará en este orden:

1. implementar y probar scripts, contratos, documentación y workflows en esta
   rama;
2. abrir la PR del pipeline y exigir el CI existente;
3. revisar y fusionar el pipeline sin exigir todavía `preview-approved`;
4. crear/configurar los environments `preview` y `premerge-review`;
5. inicializar y proteger la rama `evidence`;
6. ejecutar la prueba real de issue #4 en una PR independiente;
7. comprobar previews, PNG, comentarios, aprobación y release compartida;
8. añadir `preview-approved` a la protección obligatoria de `main`; y
9. retirar la excepción bootstrap.

Nunca se añade un check obligatorio antes de que exista una ejecución válida
capaz de producirlo. Si el ensayo falla, `main` sigue protegido por
`production-readiness`, la preview compartida anterior permanece recuperable y
producción continúa cerrada.

## 18. Criterios de aceptación

La entrega queda completa cuando:

1. los workflows y scripts están versionados y todas sus pruebas pasan;
2. los environments y secretos de preview están configurados sin exponer sus
   valores;
3. la rama `evidence` existe y rechaza reescrituras;
4. una PR real de la issue #4 produce dos Preview URLs exactas;
5. desktop y mobile muestran antes y después; la evidencia está enlazada desde
   issue y PR;
6. el merge no es posible antes de la aprobación de `premerge-review`;
7. un SHA nuevo invalida la aprobación anterior;
8. al integrar, el mismo SHA llega a la preview compartida y genera evidencia
   de release;
9. `comunidadsolar.es`, Raiola y producción no han cambiado; y
10. el runbook explica solicitud, operación, corrección y rollback sin depender
    de conocimiento tácito.

## 19. Referencias operativas

- [Cloudflare Workers Preview URLs](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/)
- [Cloudflare Workers con GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Cloudflare Workers rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
- [GitHub environments y aprobaciones](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [Retención de artifacts de GitHub Actions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)
