# Frontera operativa del agente

## Alcance

La generación de Task 7 usa un `AgentWorkspace` desechable sin `.git` y un
`IsolationBroker` configurado por el operador. Después del job, el controlador
considera hostil todo el workspace y solo entrega a Task 8 un
`StagedAgentOutput` nuevo, creado mediante copia de bytes de los archivos
regulares permitidos.

Esta arquitectura no ofrece ni afirma aislamiento de sistema operativo por sí
sola. La frontera práctica depende del entorno operativo descrito aquí y de la
adenda
`docs/superpowers/specs/2026-08-31-task-7-practical-isolation-design.md`.

## Base confiable

Se confía en:

- el host, kernel, filesystem y cuenta que ejecutan el controlador;
- el controlador de ingestión y sus archivos autoritativos;
- el broker creado por configuración del operador;
- los ejecutables fijos aprobados de Git, tar, Node y Codex/command;
- el repositorio Astro y el source sibling mientras sus snapshots de HEAD y
  estado permanezcan iguales; y
- la ausencia de otro proceso local con permisos equivalentes que manipule
  estos recursos durante el intento.

No se confía en request, plan copiado, prompt, contenido importado, proceso del
agente, stdout, stderr, mensaje final, listado declarado de archivos ni ningún
byte o metadato del workspace después de iniciar el job.

## Contrato obligatorio del broker

Un broker apto para producción debe:

- poseer el ciclo de vida completo del proceso y resolver `run` solo cuando el
  job y sus descendientes ya terminaron;
- ejecutar el comando y argv aprobados con `shell: false`;
- limitar la escritura al workspace desechable;
- proporcionar únicamente el entorno mínimo allowlisted (`PATH`, `LANG` y
  `LC_ALL` en los adaptadores actuales), sin heredar el entorno del
  controlador;
- aplicar el timeout positivo configurado por el operador, respetando el tope
  fijo de 300 segundos, y terminar el job cuando expire;
- limitar recursos y captura de stdout/stderr; y
- denegar red por defecto. Cualquier capacidad de red futura debe proceder de
  configuración confiable del operador, nunca de la solicitud.

El broker local de tests exige `INGEST_TEST_MODE=true`. Es una fixture de
contrato, no un broker publicable.

## Credenciales y autoridad de publicación

Nunca se pasan al agente tokens, cookies, claves SSH, credenciales Cloudflare,
bindings de producción, secretos D1/R2/KV, variables de deploy ni configuración
de publicación. `.change-state`, `.artifacts`, `.wrangler`, `.env*`, `.npmrc` y
los repositorios confiables quedan fuera del workspace exportado.

Gate 1, la policy Astro de Task 8, validación, creación del commit candidato,
Gate 2, promoción y publicación se ejecutan después del agente bajo autoridad
del controlador.

## Handoff controlado

El controlador revalida inputs y snapshots de repositorio, recorre el workspace
sin seguir symlinks y deriva el inventario independientemente de
`generatedFiles`. Rechaza traversal, symlinks, hardlinks no permitidos, archivos
especiales, paths no planificados y límites excedidos.

Los archivos aceptados se abren sin seguir enlaces y se copian por buffers a un
baseline limpio nuevo bajo un root temporal separado. El root y el directorio
de output tienen sufijos opacos, no codifican change/attempt y no son siblings
del workspace. `StagedAgentOutput.path`, `files` y `sha256` son
controller-owned; Task 8 debe usar ese path e inventario y no volver al
workspace del agente ni intentar derivarlo desde el path entregado.

## Exclusión de actores locales equivalentes

Las comprobaciones de paths, inodos, hashes y estado detectan errores ordinarios
y violaciones del contrato, pero no prueban resistencia frente a un proceso
local concurrente con la misma autoridad, un broker comprometido, un filesystem
hostil ni un kernel comprometido.

Un despliegue multi-tenant o que ejecute agentes/comandos de terceros debe usar
un broker operativo respaldado por un contenedor desechable o una VM/micro-VM
por job. El operador debe verificar la separación de filesystem, credenciales,
red, recursos y lifecycle en esa plataforma. La implementación actual conserva
la interfaz necesaria, pero no implementa ni certifica esa separación OS.

## Operación y diagnóstico

- Un timeout, salida inválida, input mutado o drift de repositorio cierra el
  intento sin producir staging aceptado.
- El cleanup de workspace solo elimina un `AgentWorkspace` reconocido por el
  servicio. El cleanup de staging acepta únicamente el objeto exacto reconocido
  por el controlador y elimina su root privado separado completo. Un fallo de
  cleanup conserva el directorio para diagnóstico controlado.
- Los logs persistidos deben respetar los límites y el saneado del controlador;
  no se deben copiar contenidos privados completos a incidencias.
- Antes de habilitar un broker nuevo, se deben repetir los tests de capability,
  no-shell, entorno mínimo, timeout, terminación, límites y handoff.
