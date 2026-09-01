# Operación de ingestión de páginas

La ingestión convierte una solicitud o una página aportada en un candidato
verificable. El proceso es deliberadamente cerrado: la CLI no acepta agentes de
fixture, rutas de checkout, comandos arbitrarios ni una orden de publicación.

## Flujo normal

Desde un terminal interactivo, reciba una solicitud y cree su plan:

```bash
npm run ingest -- receive request examples/requests/page-request.yaml
npm run ingest -- plan ejemplo-autoconsumo-compartido
npm run ingest -- approve ejemplo-autoconsumo-compartido --gate 1 --actor operador-responsable
npm run ingest -- generate ejemplo-autoconsumo-compartido --adapter command
npm run ingest -- validate ejemplo-autoconsumo-compartido
npm run ingest -- preview ejemplo-autoconsumo-compartido --check-only
```

Para una página aportada, entregue metadatos separados; el importador trata el
HTML como datos y no ejecuta scripts aportados:

```bash
npm run ingest -- receive page examples/pages/supplied-page.html --metadata examples/pages/page-meta.yaml
```

`approve` solicita actor si falta y siempre solicita la confirmación de los
primeros 12 caracteres del hash de Gate 1 o Gate 2. En una entrada no TTY,
omitir el actor falla cerradamente. Gate 2 se aprueba sólo después de que el
candidato esté validado:

```bash
npm run ingest -- approve ejemplo-autoconsumo-compartido --gate 2 --actor operador-responsable
```

## Estados y evidencia

La secuencia durable es:

```text
received → normalized → planned → gate1_approved → generated → validated → gate2_approved
```

Cada cambio vive bajo `.change-state/<change-id>/`: `request.json`, `plan.json`,
las aprobaciones de cada Gate, el intento, su journal y `candidate.json`. La
evidencia sellada del build y de las validaciones está bajo el candidato en
`.artifacts/candidates/<change-id>/<attempt-id>/`; los paths impresos por la
CLI nunca incluyen rutas absolutas de intake ni secretos.

Compruebe los hechos durables sin revelar contenido de entrada:

```bash
npm run verify:ingestion
```

El resultado contiene sólo identidad, estado, revisión y digests. Si falta
journal, candidato, evidencia o expediente obligatorio, devuelve `ok: false`
y el proceso termina con error.

El verificador abre únicamente la composición de auditoría durable; no inicia
Codex ni `CommandAgent`. Si detecta configuración de agente o un error de
entrada, termina con código 1 y un mensaje saneado, sin argv, PID, rutas,
variables de entorno, bundles ni stack.

## Códigos de salida

| Código | Significado |
| --- | --- |
| 0 | Operación aceptada o comprobación correcta. |
| 1 | Fallo operativo saneado. |
| 2 | Falta la aprobación humana del Gate indicado. |
| 3 | Argumento, comando o adaptador prohibido. |

La CLI productiva sólo admite `--adapter codex` o `--adapter command`. No hay
subcomando `fixture` ni `e2e` en producción.

## Configurar CommandAgent

`command` requiere una configuración aprobada por el operador antes de
generar. El controlador lee únicamente `INGEST_COMMAND_AGENT_CONFIG` como JSON
con `command`, `args` y un `timeoutMs` opcional. El ejecutable y sus argumentos
son autoridad de operación: no deben construirse a partir de la solicitud,
plan, variables de contenido o entrada del agente.

```bash
export INGEST_COMMAND_AGENT_CONFIG='{"command":"approved-ingest-agent","args":[],"timeoutMs":120000}'
npm run ingest -- generate ejemplo-autoconsumo-compartido --adapter command
```

El agente recibe por stdin sólo las rutas controller-owned de su workspace
desechable y debe devolver el JSON que valida el schema de resultado. Codex
requiere además una capability de ejecutable aprobada por el operador; no se
infiera ni se descargue automáticamente.

## Fixtures y publicación

Los fixtures pertenecen sólo a pruebas aisladas. El único entrypoint es
`npm run ingest:fixture`; exige `INGEST_TEST_MODE=true`, acepta una matriz fija
de tres combinaciones y trabaja en un clon temporal sin hardlinks. No llama a
Codex real, no usa credenciales Cloudflare y deja el estado durable en
`gate2_approved`, nunca en `published`.

Durante esta fase se ejecutan fixtures sin `--record`. El modo `--record` está
reservado a un procedimiento revisado: debe revalidar `main`, crear sólo el tag
de candidato documentado y copiar únicamente el expediente saneado. Nunca debe
fusionar `main` ni convertirse en una publicación externa.

Cuando ese procedimiento sea autorizado, el único destino durable es
`changes/<change-id>/`; `.artifacts/` conserva entradas y builds ignorados y no
puede contener un expediente grabado. El runner acepta solamente las tres
combinaciones fijas (`fixture-request-blocks`, `fixture-request-hybrid` y
`fixture-page-freeform`). Antes de cada grabación exige `main == HEAD` y un
árbol sin cambios, salvo expedientes completos y no indexados de esas mismas
tres IDs que hayan sido grabados anteriormente. Rechaza cualquier cambio
preparado, edición tracked, ID ajena, archivo parcial o enlace simbólico. Así
se pueden completar las tres grabaciones planificadas antes de ejecutar
`git add changes`, sin abrir el procedimiento a suciedad arbitraria.

Antes de crear ese tag, el runner valida de nuevo la identidad del ref
candidato, rechaza artefactos ignorados o enlaces simbólicos y escribe el
expediente en staging no enlazable. Sólo publica el staging verificado de forma
atómica y después crea el tag; un fallo deja sin tag ni expediente parcial. El
tag `refs/tags/ingestion-fixture/<change-id>` y su dossier deben formar una
pareja: `npm run verify:ingestion` descubre ambos desde el repositorio fuente,
comprueba la identidad de commit, los bindings de request/plan/Gates/intento y
los hashes de evidencia del candidato. La ausencia o modificación de cualquiera
de los dos hace que la auditoría falle cerradamente sin inicializar un agente.

**`--execute` no es una autorización implícita de deploy.** La CLI actual ni lo
acepta; una publicación Cloudflare real sigue cerrada hasta que exista una
capability de operador revisada por separado. Los dry-runs locales son
comprobaciones de candidato, no promociones de `main`.

Si una promoción futura informa reconciliación `pending`, `main` puede haber
quedado publicado aunque el checkout local no se haya reconciliado. No la
reintente ni la revierta como un cambio no publicado: conserve la evidencia,
verifique el dossier y siga el procedimiento de recuperación del operador.
