# Cierre operativo de Task 7

Fecha: 2026-08-31

Task 7 queda reconciliada con la adenda
`docs/superpowers/specs/2026-08-31-task-7-practical-isolation-design.md`. El
resultado es aislamiento práctico mediante broker y workspace Git-less; no es
una afirmación de protección OS.

## Contrato entregado

- `AgentWorkspace`: snapshot desechable del baseline, sin Git, estado
  operativo, credenciales ni configuración de publicación.
- `AgentRunInput`: proyección exacta del workspace emitida por el servicio. Los
  adaptadores Command, Codex y Fixture quedan ligados al objeto
  `AgentWorkspace` y rechazan contextos forjados.
- `IsolationBroker.run`: job completo con argv sin shell, entorno mínimo,
  timeout confiable y resultado acotado.
- `StagedAgentOutput`: path de staging, inventario ordenado y hashes derivados
  por el controlador después de tratar el workspace como hostil.
- La raíz ya no conserva la entrada obsoleta `.agent-worktrees/` en
  `.gitignore`; no queda un namespace local que sugiera autoridad Git del
  agente.

Task 8 recibe exclusivamente `StagedAgentOutput.path`,
`StagedAgentOutput.files` y `StagedAgentOutput.sha256`. No recibe un linked
worktree, una ref candidata ni paths controlados por el agente.

## Commits de implementación aceptados

- `ddeee35` — refina el plan del handoff práctico.
- `93a9d08` — hace que el broker posea la ejecución completa.
- `5cda0a8` — aplica deadlines en el broker de tests.
- `16d6e4d` — termina grupos de procesos al agotar el timeout.
- `b1a5c47` — exporta workspaces desechables Git-less.
- `52df23a` — endurece inputs y lifecycle del workspace.
- `18dc3ee` — valida output hostil y crea staging limpio.
- `b0ed4b8` — liga y acota el handoff del workspace.
- `fbc139c` — liga los timeouts a configuración confiable.

La retirada de `src/ingest/worktrees/*`, la migración final de CommandAgent y
este cierre pertenecen al commit que contiene este documento; un commit no se
autoidentifica por hash para evitar una referencia circular.

## Evidencia TDD

RED dirigido:

```text
INGEST_TEST_MODE=true npx tsx --test --test-name-pattern='service-owned agent workspace|no Git worktree or candidate-ref authority' tests/ingest/agents.test.ts
0/2 pass: Command dependía de resolveAgentRunContext y conservaba el import de worktrees.
```

GREEN dirigido:

```text
Mismo comando
2 tests, 2 pass, 0 fail
```

RED/GREEN del cierre de `.gitignore`:

```text
INGEST_TEST_MODE=true npx tsx --test --test-name-pattern='no Git worktree or candidate-ref authority' tests/ingest/agents.test.ts
RED: 1 test, 0 pass, 1 fail mientras .gitignore contenía .agent-worktrees/.
GREEN: 1 test, 1 pass, 0 fail después de retirar exactamente esa entrada.
```

GREEN enfocado:

```text
INGEST_TEST_MODE=true npm run test:unit -- tests/ingest/agents.test.ts
50 tests, 50 pass, 0 fail
```

La variable `INGEST_TEST_MODE=true` se limita a la suite de agentes porque
habilita sus brokers/fixtures locales. La suite completa se ejecuta sin esa
variable; así conserva el test de approvals que exige rechazo de Fixture fuera
del modo de prueba.

## Matriz final

```text
npm run format:check   PASS (incluye el cierre de .gitignore)
npm run lint           PASS
npm run check          PASS (242 files, 0 errors, 0 warnings, 3 hints)
npm run test:unit      PASS (517 tests, 517 pass, 0 fail, 0 cancelled)
npm run build          PASS
npm run source:check   SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean
git diff --check       PASS (incluye el cierre de .gitignore)
```

El diagnóstico previo reprodujo dos veces el timeout exterior de 120 s del test
de topología Wrangler, incluso con `--test-concurrency=1`; el resto de la suite,
excluyendo únicamente ese archivo, pasó 498/498. La resolución estrecha amplía
sólo el presupuesto exterior del test a 180 s, que incluye ambas pasadas de
paridad y su cleanup. El timeout hijo del build permanece en 90 s; no se
relajaron aserciones, comportamiento de producción, runner ni otros tests. La
prueba aislada final pasó 1/1 en 26.8 s y la suite completa pasó 517/517 en
65.2 s.

## Resultado sobre el source

No se modificó el repositorio fuente. La guardia registra:

```text
SOURCE_OK 68ea294c54dc5e15e20f470fc421a239927565a8 clean
```

## Frontera residual

Se confía en host, kernel, filesystem, controlador, repositorios y broker del
operador. No se garantiza protección frente a un proceso local concurrente con
autoridad equivalente, broker/host comprometido ni escape del aislamiento que
aporte el operador. Un despliegue multi-tenant requiere un broker respaldado
por contenedor o VM/micro-VM; el broker local de tests no cumple ese papel.

La comprobación estructural de Task 7 no sustituye la policy de contenido Astro
ni la comparación exacta de dependencias. Ambas pertenecen a Task 8.

## Siguiente tarea

Task 8 es la siguiente tarea. Debe aplicar la policy Astro determinista al path,
inventario y hashes controller-owned de `StagedAgentOutput`, sin reabrir el
workspace hostil ni confiar en la lista declarada por el agente.
