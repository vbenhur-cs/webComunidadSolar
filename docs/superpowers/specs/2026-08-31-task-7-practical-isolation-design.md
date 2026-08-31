# Diseño del aislamiento práctico para la Task 7

Estado: aprobado conceptualmente en conversación el 31 de agosto de 2026;
pendiente de revisión de este documento antes de implementar.

## 1. Contexto y decisión

La Task 7 de
`docs/superpowers/plans/2026-08-21-astro-04-ingestion-publication.md`
implementó worktrees y adaptadores de agente, pero su revisión intentó demostrar
aislamiento frente a un proceso local hostil que pudiera cambiar rutas, Git y
archivos entre dos comprobaciones del controlador. Diez rondas de reparación
confirmaron que esa propiedad no puede demostrarse con comprobaciones de paths
en Node cuando agente y controlador comparten host y filesystem mutables.

La decisión es acotar formalmente el modelo de amenazas. El sistema seguirá
tratando como hostiles la entrada, el prompt, el proveedor y todos sus
resultados, pero confiará en el host, el controlador y el broker configurado por
el operador. La Task 7 no afirmará resistencia frente a un kernel comprometido,
un broker malicioso ni otro proceso local con la misma autoridad que manipule
el workspace durante el handoff.

Esta adenda sustituye, cuando exista conflicto, las garantías de aislamiento de
las secciones 5.4 y 10 de
`docs/superpowers/specs/2026-08-21-astro-parity-ingestion-design.md`. No cambia
los gates humanos, la validación determinista, la inmutabilidad del repositorio
fuente ni la prohibición de publicar desde un agente.

## 2. Objetivos de seguridad

La implementación debe:

1. inspeccionar páginas, paquetes y prompts sin confiar en su contenido;
2. impedir que datos no confiables se conviertan en argv, shell, variables de
   entorno, paths o autoridad de publicación sin validación;
3. ejecutar cada agente mediante un broker explícito del operador;
4. entregar al agente únicamente un snapshot desechable sin metadatos Git,
   estado operativo, credenciales ni configuración de publicación;
5. considerar no confiable el workspace completo después de ejecutar el
   agente;
6. aceptar únicamente archivos regulares, paths y bytes expresamente
   permitidos por el plan aprobado;
7. importar la salida aceptada por copia de bytes a un checkout limpio y
   controlado, nunca reutilizando inodos, symlinks o metadatos del workspace;
8. mantener Gate 1, validación, Gate 2, creación del candidato y publicación
   fuera del proceso del agente;
9. fallar cerrado ante un broker ausente, protocolo inválido, timeout,
   mutación de inputs, salida no declarada o evidencia incompleta; y
10. dejar una frontera de confianza comprensible, verificable y sustituible por
    aislamiento OS en el futuro.

## 3. Frontera de confianza

### 3.1 Componentes confiables

Forman parte de la base confiable:

- el kernel, filesystem y cuenta del operador;
- el proceso controlador de ingestión;
- el broker de aislamiento configurado por el operador y su promesa de limitar
  escritura, controlar el ciclo de vida del proceso y devolver solo después de
  finalizar el job;
- el ejecutable fijo de Git usado por el controlador;
- el repositorio Astro y el repositorio fuente mientras sus guardias de
  commit/estado estén verdes;
- las copias autoritativas del request, plan, policy y schemas guardadas fuera
  del workspace del agente; y
- la ausencia de otro proceso local con la misma autoridad que manipule esos
  recursos durante un intento.

### 3.2 Material no confiable

Nunca se confía en:

- Markdown, YAML, JSON, HTML, Astro, TSX, carpetas o ZIP aportados;
- instrucciones contenidas en páginas o prompts;
- el proceso Codex o command ejecutado por el broker;
- stdout, stderr, exit code declarado, mensaje final o listado de archivos del
  agente;
- ningún archivo, path, symlink, metadato o manifest dentro del workspace una
  vez iniciado el agente; ni
- código generado aunque coincida visualmente con la solicitud.

### 3.3 Amenazas fuera de alcance

La Task 7 no garantiza protección frente a:

- un kernel, filesystem o broker comprometido;
- un escape del mecanismo de aislamiento del broker;
- un proceso local concurrente con permisos equivalentes al controlador;
- cambios físicos de path o inodo realizados después de la última lectura del
  controlador por un actor externo al job ya terminado; ni
- disponibilidad frente a agotamiento del host fuera de los límites que
  aplique el broker.

Estas exclusiones no autorizan saltarse validaciones. Definen quién debe
aplicar la separación: el broker y el entorno operativo, no una cadena infinita
de comprobaciones TOCTOU en Node.

## 4. Arquitectura aprobada

```text
request + plan aprobado + policy autoritativa
                    |
                    v
        controlador crea snapshot exportado
        (directorio temporal, sin .git ni secretos)
                    |
                    v
       broker confiable ejecuta el agente
       (argv fijo, sin shell, env mínimo, timeout)
                    |
                    v
       job terminado; workspace entero hostil
                    |
                    v
     protocolo + inventario estructural independiente
                    |
                    v
       copia por bytes de archivos permitidos
       a un checkout limpio del controlador
                    |
                    v
       policy Task 8 -> validación -> candidato -> Gate 2
```

El agente no recibe un linked worktree ni acceso a `.git`. El controlador
exporta el árbol del baseline aprobado a un directorio temporal nuevo y añade
copias de `request.json`, `plan.json`, policy y schema. El snapshot excluye
`.git`, `.change-state`, `.agent-worktrees`, `.agent-quarantine`, artefactos,
credenciales y configuración operativa no necesaria.

La API pública dejará de describir este directorio como `CandidateWorktree` y
lo modelará como `AgentWorkspace`. La creación del commit candidato pertenece
a la etapa de candidato, después de validar e importar la salida; no forma
parte de la autoridad del agente.

## 5. Contrato del broker

El broker es una dependencia obligatoria de producción y pruebas explícitas.
Su contrato será de ejecución, no solo de reescritura de command/argv:

```ts
export interface BrokerRunInput {
  workspace: string;
  command: string;
  args: readonly string[];
  stdin: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
}

export interface BrokerRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface IsolationBroker {
  run(input: BrokerRunInput): Promise<BrokerRunResult>;
}
```

El controlador no acepta un broker estructural creado a partir de datos de la
solicitud. Solo una capacidad creada por configuración del operador puede
ejecutar. `CommandAgent` y `CodexAgent` nunca llaman directamente a
`spawn`/`exec`; delegan el job completo al broker.

El contrato confiable del broker establece que:

- no usa shell y conserva los argv exactos aprobados;
- el único root escribible del job es el workspace desechable;
- no inyecta secretos ni variables no allowlisted;
- aplica timeout y límites operativos configurados;
- termina el job antes de resolver `run`; y
- no mantiene procesos del job con acceso al workspace tras resolver.

El broker local de tests solo se habilita con `INGEST_TEST_MODE=true` y no es
una capacidad publicable. Un futuro broker de contenedor o VM podrá implementar
la misma interfaz sin cambiar adaptadores, validadores ni candidatos.

## 6. Preparación y ejecución del workspace

Para cada intento, el controlador:

1. verifica Gate 1, baseline, hashes y limpieza de los repositorios;
2. crea un directorio temporal nuevo bajo un root operativo controlado;
3. exporta el baseline sin `.git` y genera un manifest determinista de paths,
   tipos, modos, tamaños y SHA-256;
4. copia inputs y schemas autoritativos, registrando sus hashes;
5. marca como no escribibles los inputs cuando el host lo permita, sin tratar
   ese permiso como frontera de seguridad;
6. construye argv, stdin y env únicamente desde configuración confiable y datos
   serializados; y
7. llama una vez al broker y espera su resultado terminal.

Codex continuará usando modo efímero y sandbox `workspace-write`. El command
adapter exige un ejecutable/argv configurado por el operador. Ninguno recibe
variables de publicación, tokens, cookies, D1 de producción o paths del
repositorio fuente.

Network queda denegada por defecto. Un broker podrá habilitarla solo mediante
una capability del operador vinculada al plan aprobado; la primera versión no
expone esa opción desde material de entrada.

## 7. Handoff y validación posterior

Después de que el broker resuelva, el controlador no confía en ninguna
afirmación del agente. Debe:

1. rechazar timeout o exit code distinto de cero;
2. validar límites de stdout/stderr antes de conservar logs saneados;
3. parsear el mensaje final con un schema cerrado;
4. volver a calcular hashes de request, plan, policy y schemas copiados;
5. recorrer el workspace sin seguir symlinks;
6. comparar el manifest final con el baseline exportado;
7. rechazar archivos especiales, symlinks, hardlinks no admitidos, paths con
   traversal, cambios fuera de `plan.files` y roots generados aprobados;
8. volver a comprobar commit/estado de los repositorios confiables; y
9. producir un inventario estructural y hashes para que la Task 8 aplique la
   policy Astro determinista sobre la copia confiable.

Los paths declarados por el agente sirven solo como pista protocolaria. El
inventario aceptado procede del recorrido independiente del controlador.

Los archivos estructuralmente aceptados se abren sin seguir symlinks, se leen
con límites y se copian como bytes nuevos a un checkout limpio creado por el
controlador. Allí se recalculan hashes y se comprueba que coincidan con el
inventario aprobado. No se mueve, enlaza ni reutiliza ningún archivo del
workspace. La Task 7 entrega esa copia y su inventario; la Task 8 decide si su
contenido Astro cumple la policy de salida.

La eliminación del workspace es higiene operativa, no una operación de
autoridad Git. Ante un fallo se puede conservar una copia saneada para
diagnóstico; nunca contiene secretos ni capacidad de publicación.

## 8. Concurrencia y lifecycle

Solo puede existir un intento activo por `changeId`. El state store conserva
el lock hasta que el broker termina, el handoff concluye y el intento queda en
estado terminal. Un reintento usa un nuevo `attemptId` y un directorio nuevo.

El sistema confía en que el broker no resuelve mientras quede un proceso del
job. No intentará demostrar esa propiedad inspeccionando repetidamente paths o
procesos desde Node. Si un broker no puede ofrecerla, no es apto para
producción.

El repositorio fuente y el checkout controlador se verifican antes y después
del intento. Una diferencia rechaza el intento, pero estas guardias detectan
errores y violaciones de contrato; no afirman resistencia a un atacante local
concurrente fuera del modelo.

## 9. Manejo de errores

- Broker ausente o no autorizado: rechazo antes de crear el job.
- Timeout: el broker termina el job y el intento queda `failed`.
- Resultado malformado o excesivo: `failed`, sin importar el exit code.
- Input o policy copiados mutados: `rejected` y no se importa salida.
- Symlink, archivo especial o path no aprobado: `rejected`.
- Cambio del repositorio fuente/controlador: `failed` y requiere inspección.
- Fallo durante la copia al checkout limpio: se descarta ese checkout y el
  último candidato válido permanece intacto.
- Fallo de policy, build o tests posteriores: `failed`; Gate 2 no está
  disponible.

Los errores conservan identificador de intento, categoría y hashes útiles, sin
persistir contenido privado completo.

## 10. Estrategia de pruebas y aceptación

La Task 7 queda cerrada cuando pruebas deterministas demuestran:

- broker obligatorio, capability de operador y rechazo del broker fixture en
  producción;
- argv sin shell, env mínimo, timeout y terminación previa al handoff;
- workspace nuevo sin `.git`, estado operativo, secretos ni configuración de
  publicación;
- rechazo de mutación de inputs, protocolo inválido, traversal, symlink,
  hardlink inseguro, archivo especial y salida no planificada;
- inventario independiente del listado declarado por el agente;
- importación por copia de bytes a un checkout limpio con hashes idénticos;
- repositorio fuente y checkout controlador sin cambios atribuibles al job;
- FixtureAgent y CommandAgent válidos; Codex se prueba por contrato sin lanzar
  generación real; y
- format, lint, Astro check, suite unitaria, build y guardia del source en
  verde.

Las pruebas que intentan demostrar protección contra swaps realizados por un
actor local concurrente fuera del job se retirarán o se convertirán en pruebas
de detección best-effort. No serán criterios de aceptación ni justificarán una
afirmación de aislamiento OS.

## 11. Evidencia y documentación operativa

El informe de Task 7 registrará:

- la versión de esta adenda;
- el tipo e identidad del broker usado;
- hashes de baseline, inputs y outputs aceptados;
- límites de ejecución aplicados;
- tests ejecutados y resultados; y
- la advertencia explícita de que el aislamiento frente a actores locales
  concurrentes depende del broker y del host.

README y documentación operativa explicarán que un despliegue multiusuario o
expuesto a agentes/comandos de terceros requiere un broker respaldado por
contenedor, namespace o VM. El broker local no se presentará como frontera
multi-tenant.

## 12. Consecuencias y evolución

Esta decisión reduce complejidad y elimina garantías imposibles de sostener con
la arquitectura actual. También hace más clara la separación entre generación
hostil y creación confiable del candidato. El coste es aceptar que la seguridad
frente a un actor local concurrente pertenece al entorno operativo.

Si el sistema evoluciona a un servicio público multiusuario, se revisará esta
decisión antes de habilitarlo. La interfaz del broker permitirá introducir un
worker Linux aislado, contenedor desechable o micro-VM que reciba un snapshot
inmutable y devuelva un artefacto por canal controlado. Esa evolución reforzará
el mismo flujo; no cambiará schemas, gates ni publicación.

## 13. Decisiones cerradas

- La Task 7 adopta el modelo de amenazas acotado descrito aquí.
- El broker y el host forman parte de la base confiable.
- El agente nunca recibe metadatos Git ni autoridad de publicación.
- Generación y creación del candidato son etapas distintas.
- La salida se importa por copia de bytes a un checkout limpio.
- Las comprobaciones TOCTOU best-effort no se presentan como aislamiento OS.
- Gate 1, Gate 2 y publicación permanecen fuera del agente.
- La Task 8 consume el inventario importado y aplica la policy Astro cerrada.
