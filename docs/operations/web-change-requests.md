# Solicitar cambios en la web

Esta guía permite pedir un cambio en Comunidad Solar sin conocer Astro, Git ni
Cloudflare. Se puede escribir la petición con lenguaje natural, pero debe dejar
claros el resultado, la ruta, el alcance y quién lo aprobará.

El canal oficial es una
[Solicitud de cambio web en GitHub](https://github.com/vbenhur-cs/webComunidadSolar/issues/new/choose).
Si la persona solicitante no tiene acceso, el responsable web puede abrirla en
su nombre. Una issue no publica nada por sí sola y permanece abierta hasta que
el cambio aceptado llegue a la preview compartida y reciba su comentario de
release.

## Resumen del proceso

```text
Issue abierta
  → Pull Request
  → Production readiness en verde
  → preview base
  → preview candidata
  → evidencia PNG permanente
  → aprobación humana en premerge-review
  → merge en `main`
  → preview compartida y comentario de release
```

El orden es deliberado: se compara y aprueba el cambio antes del merge. La
preview compartida confirma después que el SHA integrado es el mismo que se
revisó. Ningún paso de este flujo modifica `comunidadsolar.es`, Raiola ni
producción.

## Qué libertad tiene la persona solicitante

Puedes explicar la necesidad como te resulte más cómodo y proponer texto,
estructura, imágenes o referencias. El equipo puede ayudarte a concretarla,
pero no inventará cifras, derechos de uso, condiciones legales ni una
aprobación. Antes de desarrollar deben quedar definidos:

- el objetivo y para quién se hace;
- la URL actual y la ruta exacta deseada, siempre con `/` inicial y final;
- si se revisará la página completa o una sección concreta;
- el cambio exacto y su fuente autorizada;
- criterios comprobables en móvil y escritorio; y
- la persona responsable de aprobar contenido, negocio o legal.

Para identificar una página existente, pega su URL completa y escribe también
su ruta, por ejemplo `/autoconsumo-remoto`. Para una página nueva, indica la
ruta deseada aunque todavía devuelva 404.

## Dos modelos de solicitud

### A. Página completa nueva

```text
Título: [Web] Crear guía para comunidades de propietarios
Objetivo: explicar los pasos y llevar a una solicitud de contacto.
URL actual: no existe.
Ruta exacta deseada: /pruebas/guia-comunidades-propietarios/
Alcance de evidencia: Página completa.
Cambio: página con introducción, pasos, preguntas frecuentes y CTA.
Fuente: documento aprobado <enlace o responsable>.
Materiales: No aplica / enlaces y permisos de los archivos aprobados.
Criterios: base 404; candidata 200; contenido y CTA correctos en móvil y
escritorio; noindex mientras esté bajo /pruebas/.
Aprobador: <nombre y área>.
```

La PR implementadora añadirá exactamente un contrato
`evidence/requests/issue-<N>.yaml`, sustituyendo `<N>` por el número real:

La ruta debe copiar la URL canónica del proyecto: `/` para la portada y sin
barra final para cualquier otra página. Así la captura verifica directamente
el estado esperado y no el estado intermedio de una redirección.

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

### B. Sección de una página existente

```text
Título: [Web] Actualizar beneficios de autoconsumo remoto
Objetivo: aclarar tres ventajas para una persona que compara opciones.
URL actual: https://<sitio>/autoconsumo-remoto
Ruta exacta: /autoconsumo-remoto
Alcance de evidencia: Sección concreta.
Selector estable: [data-evidence-id='beneficios']
Cambio: sustituir el contenido actual por <texto aprobado>.
Fuente: <enlace o responsable>.
Criterios: base y candidata 200; sección y página completa legibles en móvil y
escritorio; enlaces correctos.
Aprobador: <nombre y área>.
```

La sección debe tener un identificador estable en el HTML. Se recomienda
`data-evidence-id` porque expresa su finalidad sin depender del estilo:

```astro
<section data-evidence-id="beneficios">
```

Y su contrato será:

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

El pipeline admite selectores simples `#id`, `.clase` o
`[data-evidence-id='nombre-en-kebab-case']`; no admite selectores ambiguos ni
ejecutables. Aunque el alcance sea una sección, conserva también capturas de la
página completa para detectar efectos colaterales.

## Información especial según el cambio

| Tipo | Información adicional necesaria |
| --- | --- |
| Texto, titular o CTA | Texto literal, tono, fuente de cifras y ubicación concreta. |
| Imagen, vídeo o logo | Archivo estable, autoría, permiso de uso, crédito y texto alternativo. |
| Página o campaña | Estructura, contenido aprobado, CTA, SEO, fecha de retirada y responsable. |
| Comunidad, proyecto o dato | Municipio, fecha de corte, estado, fuente y persona que lo confirma. |
| Formulario o captación | Finalidad, campos mínimos, destinatario, conservación, consentimiento y mensajes. |
| Legal, precio o promesa | Texto aprobado, fecha de vigencia, fuente contractual y autorización expresa. |
| URL, navegación o SEO | Origen, destino, enlaces internos, metadatos y redirección necesaria. |
| Calculadora externa | URL y propietario externos, finalidad y comportamiento; nunca sus credenciales. |
| Error técnico | Pasos, URL, navegador/dispositivo, resultado actual, esperado y captura útil. |

Para cualquier asset, adjunta el original o un enlace estable. Una imagen
borrosa, un enlace temporal o un archivo sin permiso de uso no constituyen un
material aprobado.

## Datos que nunca deben incluirse

No publiques en la issue, PR, comentarios, capturas ni adjuntos:

- contraseñas, tokens, claves API o perfiles Cloudflare;
- datos personales, CUPS, teléfonos, correos, facturas o contratos de clientes;
- cookies, cabeceras de autenticación o enlaces que concedan acceso; ni
- información confidencial no autorizada para una web pública.

Usa ejemplos anonimizados. Las rutas privadas y los endpoints API no son
admisibles como objetivo de captura en esta primera versión.

## Qué ocurre después de abrir la issue

1. El responsable comprueba objetivo, alcance, fuente, aprobador y aceptación.
2. El cambio se desarrolla en una rama interna y se abre una Pull Request que
   enlaza la issue sin cerrarla.
3. `Production readiness` valida formato, tipos, contratos, enlaces, imágenes,
   navegación, servidor, build independiente y bundle Cloudflare sin publicar
   en producción.
4. El pipeline confiable compila el SHA base y el SHA candidato sin entregar
   secretos al código de la PR. Cloudflare crea dos Preview URLs aisladas que
   no sustituyen la preview compartida.
5. Chromium comprueba los estados HTTP y genera PNG de escritorio y móvil. Si
   se pidió una sección, añade sus dos recortes.
6. Los PNG y manifiestos con hashes se guardan de forma append-only en la rama
   `evidence`. La PR y la issue reciben enlaces raw permanentes, los SHAs y las
   dos URLs operativas.
7. El job espera en `premerge-review`. La persona autorizada compara antes y
   después y aprueba o solicita correcciones.
8. Solo la aprobación de esa evidencia permite emitir `preview-approved` sobre
   el SHA candidato exacto y desbloquear el merge.
9. Después del merge, ese SHA se despliega a
   `https://comunidad-solar-preview.comunidadsolar-dev.workers.dev`, se captura
   de nuevo y se añade el comentario de release.

Las Preview URLs de una versión pueden caducar; los PNG, hashes y manifiestos
de la rama `evidence` no dependen de que sigan vivas.

### Pull Requests desde un fork

Una PR desde un fork ejecuta CI sin secretos, pero no recibe previews
privilegiadas ni `preview-approved`. Una persona responsable debe revisar el
diff y trasladarlo a una rama interna del repositorio para continuar. Nunca se
habilitan secretos en código de un fork.

### Correcciones y reintentos

- Reintentar el mismo SHA reutiliza la identidad de evidencia y no sobrescribe
  bytes existentes.
- Un SHA nuevo por cualquier corrección exige previews, evidencia y aprobación
  nueva. La aprobación anterior no sirve para el nuevo head.
- Si el selector desaparece, un estado HTTP no coincide, Chromium informa un
  error o una captura es inválida, el flujo falla y no solicita aprobación.

La persona aprobadora debe comentar correcciones concretas o confirmar la
versión revisada. «Aprobado» sin la evidencia del SHA actual no sustituye el
gate de GitHub.

## Cuándo se cierra la solicitud

La issue debe seguir abierta durante desarrollo, preview, aprobación y merge.
Solo se cierra cuando existe el comentario de release con:

- SHA integrado y enlace a la ejecución;
- URL de la preview compartida;
- capturas y manifiesto permanentes;
- resultado de las comprobaciones; y
- limitaciones o trabajo posterior, si lo hay.

Una release en preview no significa publicación en el dominio principal. El
paso a producción tiene un workflow manual distinto y permanece bloqueado
hasta su habilitación explícita.

## Rollback y recuperación

- **Antes del merge:** cerrar la PR detiene la promoción; `main` no cambia.
- **Después del merge:** abrir una PR nueva con `git revert <sha>` y repetir
  CI, previews, evidencia y aprobación. No se reescribe el historial.
- **Worker desplegado:** volver a una versión anterior conocida de Cloudflare,
  registrar versión, actor y motivo, y después preparar la PR correctiva.

Revertir el Worker no revierte D1 o KV. Los cambios de datos necesitan un plan
compatible hacia atrás y una recuperación revisada por separado.

## Prioridad y reglas editoriales

| Prioridad | Cuándo usarla |
| --- | --- |
| Crítico | Seguridad, privacidad, incumplimiento legal, información gravemente incorrecta o bloqueo real. |
| Alta | Campaña confirmada, página importante rota o impacto comercial significativo. |
| Normal | Cambio habitual de contenido o funcionalidad. |
| Baja | Idea futura o trabajo sin fuente, fecha o contenido definitivo. |

La prioridad acelera la atención, pero no elimina trazabilidad ni aprobación.
Cada cifra necesita fuente y fecha; los cambios legales necesitan validación
expresa; una URL pública exige revisar enlaces, sitemap, redirecciones y SEO;
y todo asset necesita alternativa accesible y permiso de uso.

El procedimiento técnico completo está en el
[runbook de pruebas y releases](production-release-runbook.md). La
[guía de ingestión](ingestion.md) solo se usa para páginas que entren por esa
CLI y sus dos gates formales.
