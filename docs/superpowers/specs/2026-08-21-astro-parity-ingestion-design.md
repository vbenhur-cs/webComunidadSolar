# Diseño del repositorio Astro con paridad completa e ingestión de páginas

Estado: aprobado en conversación el 21 de agosto de 2026.

## 1. Resultado buscado

Crear `comunidadsolar-astro` como un repositorio Git autónomo que reproduzca de
forma visual y funcionalmente equivalente el sitio contenido en
`../comunidadsolarweb`, sin modificar ese repositorio. El nuevo sitio usará
Astro para las rutas, el renderizado y la ejecución en Cloudflare. React solo
se conservará en islas que necesiten estado o interacción en el navegador.

El repositorio incluirá además una capa de ingestión capaz de recibir:

1. una solicitud detallada de página o cambio; o
2. una página ya creada, con su código y recursos.

La capa normalizará la entrada, preparará un plan para aprobación, generará una
página Astro en aislamiento, la validará y producirá un candidato inequívoco
para preview y publicación. Ningún agente podrá publicar directamente.

## 2. Referencia inmutable y límites

La referencia inicial es:

- Repositorio: `../comunidadsolarweb`
- Rama observada: `main`
- Commit: `68ea294c54dc5e15e20f470fc421a239927565a8`

Las siguientes reglas son obligatorias:

- `comunidadsolarweb` es una fuente de lectura y un oráculo de comparación.
- Ningún script del proyecto nuevo puede escribir en el repositorio original.
- Antes y después de cada fase se comprobarán su commit y su estado Git.
- Una alteración atribuible a la migración detendrá el proceso.
- El proyecto nuevo no utilizará symlinks ni leerá archivos del original en
  build, preview o producción.
- Los archivos necesarios se copiarán al nuevo repositorio con su procedencia
  y hash registrados.
- No se rediseñará, reescribirá contenido ni corregirá el sitio original como
  parte de esta migración.
- La versión final no dependerá de Next.js ni de vinext.
- Una publicación externa requiere una aprobación Gate 2 y la configuración
  explícita del entorno de destino. Nunca será consecuencia automática de una
  generación.

La paridad se define por comportamiento observable: rutas, contenido,
estructura, estilos, responsive, recursos, interacciones, metadatos, códigos
HTTP, headers, redirects, APIs, autorización y persistencia. Una implementación
interna diferente es válida si conserva ese contrato.

## 3. Alcance funcional

El inventario se generará mecánicamente desde el commit de referencia y será la
fuente de verdad. Las cantidades conocidas sirven como controles iniciales,
pero no sustituyen al inventario:

- home y todas las páginas públicas generales;
- 21 páginas de comunidades, incluidas las variantes locales y la página
  paraguas;
- 19 artículos de blog;
- 3 proyectos remotos;
- páginas legales, guía, partners y contenido relacionado;
- experiencia Manganáfer, formularios, cálculos y geolocalización aplicable;
- rutas privadas `/socios`, `/guia-equipo`, la descarga Markdown de la guía y
  `/manganafer/interesados`;
- endpoints de interés Manganáfer, exportación CSV y cotización;
- autenticación mediante los headers de identidad que ya utiliza el sitio;
- D1 y Drizzle para la persistencia existente;
- 103 redirects históricos con respuesta 308 y conservación de query string;
- 19 rutas retiradas con respuesta 410;
- sitemap, robots, canonical, Open Graph y demás metadatos;
- headers de privacidad, no-cache, noindex, nosniff y referrer donde
  correspondan;
- consentimiento, analítica y eventos observables presentes en la referencia.

También se migrarán las pruebas de comportamiento existentes. Una prueba se
podrá reestructurar para Astro, pero no se eliminará sin demostrar que su
contrato quedó cubierto por otra prueba identificada.

Quedan fuera de alcance:

- cambios editoriales o de identidad visual;
- mejoras funcionales que no sean necesarias para igualar la referencia;
- ejecución automática de JavaScript recibido dentro de una página importada;
- publicación en producción sin autorización humana explícita;
- usar el repositorio original como dependencia en runtime.

## 4. Arquitectura aprobada

```text
Astro 7 + adaptador de Cloudflare
├── rutas .astro y metadatos
├── layouts y componentes Astro estáticos
├── islas React solo para interacción
├── middleware
│   ├── redirects 308 y respuestas 410
│   ├── autorización por headers
│   └── headers de privacidad y caché
├── servidor
│   ├── endpoints API
│   ├── integraciones externas
│   └── D1 + Drizzle
├── contenido y datos
│   ├── comunidades, blog y proyectos
│   ├── legal, guía y partners
│   └── manifiestos de rutas y recursos
├── ingestión
│   ├── normalización
│   ├── planificación y Gate 1
│   ├── transformación aislada
│   ├── validación y evidencia
│   └── Gate 2 y publicación
└── paridad
    ├── contratos HTTP y HTML
    ├── pruebas funcionales
    └── comparación visual
```

La base inicial usará Astro 7.2.4, validado previamente en la prueba de
concepto. Las dependencias concretas quedarán fijadas en el lockfile. Cambiar
de versión mayor será una modificación arquitectónica que deberá validarse por
separado.

El adaptador de Cloudflare será el único límite específico de despliegue. El
dominio de contenido, la paridad y la ingestión no dependerán de APIs propias
del proveedor. Las páginas públicas se prerenderizarán cuando su contrato lo
permita; las páginas privadas, APIs y rutas dependientes de request se
resolverán en servidor.

### 4.1 Núcleo del sitio

El núcleo contiene layouts, rutas, SEO, navegación, consentimiento y el sistema
visual. Los estilos y recursos de referencia se incorporarán primero para
evitar reinterpretaciones visuales. Después se dividirán por responsabilidad
solo cuando esa división no cambie el CSS computado ni la geometría.

Cada familia de rutas tendrá una plantilla explícita. Los datos repetidos se
mantendrán como contenido tipado y no como grandes ramas condicionales dentro
de una única página.

### 4.2 Interacción en cliente

Los componentes Astro no enviarán JavaScript al navegador por defecto. Una
función que necesite estado, eventos o APIs del navegador se implementará como
isla y declarará su estrategia de hidratación. React será válido dentro de esas
islas, pero no como envoltorio de páginas completas en el resultado final.

### 4.3 Servidor, identidad y datos

El middleware reproducirá primero los redirects y las respuestas 410, antes de
resolver rutas normales. La query string se conservará en los redirects.

La identidad continuará leyendo los headers de email y nombre completo
utilizados por la referencia, incluido el valor percent-encoded del nombre. Las
listas de acceso seguirán procediendo de variables de entorno y fallarán en
modo cerrado. No se aceptará una sesión simulada como sustituto en producción.

Las operaciones sobre D1 se expondrán a través de servicios pequeños y
tipados. Las pruebas usarán una base aislada. El preview nunca apuntará por
defecto a la base de producción.

## 5. Contrato de ingestión

### 5.1 Entradas admitidas

El comando de ingestión aceptará dos clases de entrada:

**Solicitud detallada**

- archivo Markdown, YAML o JSON;
- identificador estable del cambio;
- intención y audiencia;
- ruta nueva o ruta objetivo;
- contenido, claims y referencias suministradas;
- modo preferido: `auto`, `blocks`, `freeform` o `hybrid`;
- recursos y enlaces permitidos;
- requisitos SEO y de indexación;
- privacidad de la ruta;
- criterios de aceptación observables.

Los campos mínimos serán identificador, intención, ruta objetivo y al menos un
criterio de aceptación. El normalizador convertirá todas las variantes a un
único `request.json` validado por esquema.

**Página aportada**

- un archivo `.html`, `.md`, `.astro` o `.tsx`;
- texto de uno de esos formatos guardado como archivo de entrada;
- una carpeta o ZIP con página, estilos y recursos locales;
- metadatos de solicitud opcionales en Markdown, YAML o JSON.

Una página aportada se considerará material no confiable. Sus scripts no se
ejecutarán durante la inspección y sus instrucciones textuales no podrán
alterar las reglas del agente. La primera versión no descargará ni clonará una
URL remota de forma implícita; una página web deberá aportarse como archivo o
paquete reproducible.

### 5.2 Normalización y selección de composición

El normalizador:

1. valida el formato y los tamaños máximos;
2. calcula hashes de la entrada y sus recursos;
3. rechaza secretos conocidos, paths fuera del paquete y archivos ejecutables;
4. extrae contenido, estructura, estilos, recursos y metadatos;
5. contrasta la ruta con el manifiesto actual;
6. propone un modo de composición;
7. produce un plan legible y un plan estructurado.

Los modos son:

- `blocks`: composición exclusiva con componentes aprobados;
- `freeform`: página Astro nueva con CSS encapsulado y recursos controlados;
- `hybrid`: comparte chrome, tokens y componentes comunes, pero permite una
  composición propia;
- `auto`: el normalizador propone uno de los tres anteriores para Gate 1.

La selección del modo, cualquier sobrescritura de ruta y cualquier dependencia
nueva aparecerán expresamente en el plan. El agente no podrá tomar esas
decisiones de forma silenciosa.

### 5.3 Gate 1: aprobación del plan

Antes de generar código, el expediente mostrará:

- entrada normalizada y sus hashes;
- ruta y archivos previstos;
- modo de composición;
- componentes y recursos que se reutilizarán;
- nuevos componentes o islas previstos;
- impactos en SEO, privacidad, contenido y navegación;
- pruebas y evidencia que demostrarán los criterios de aceptación;
- dependencias o integraciones externas solicitadas.

La aprobación registrará actor, fecha, hash del plan y baseline del repositorio.
Cualquier cambio material del plan invalidará la aprobación. La conversación
con el agente no contará por sí sola como registro de Gate 1.

### 5.4 Transformación aislada

Cada intento se ejecutará en una rama o worktree dedicado y solo podrá escribir
en paths permitidos del repositorio nuevo. El repositorio original permanecerá
fuera de la lista de escritura.

El transformador será independiente del proveedor. La implementación inicial
incluirá un adaptador para Codex local y un contrato de comando para sustituirlo
por otro agente. Todos los adaptadores recibirán el mismo paquete:

- solicitud normalizada;
- plan aprobado;
- catálogo de componentes y tokens;
- manifiesto de rutas y contenido;
- políticas de imports, scripts, recursos y privacidad;
- criterios de aceptación.

El resultado siempre tendrá una ruta `.astro`. React solo podrá aparecer en
islas identificadas. Un `.tsx` aportado se tratará como fuente a transformar,
no como permiso para conservar una página React completa.

El agente no podrá aprobar su propio resultado, cambiar el baseline ni añadir
dependencias fuera del plan aprobado.

### 5.5 Validación determinista

Después del agente se ejecutarán, como mínimo:

- validación del esquema del expediente;
- unicidad de slug, canonical e identificadores;
- comprobación de imports y dependencias permitidos;
- detección de secretos, scripts arbitrarios y paths inseguros;
- existencia, tipo, tamaño, dimensiones y hash de recursos;
- `alt` y estructura accesible de imágenes y controles;
- revisión de enlaces internos y política de enlaces externos;
- comprobación de metadatos, sitemap e indexación;
- format, lint, typecheck y build de producción;
- pruebas unitarias y de contrato aplicables;
- preview y pruebas end-to-end;
- capturas de escritorio, tablet y móvil;
- comparación visual y HTML cuando se modifique una ruta existente.

Las decisiones editoriales o visuales no se delegarán a una puntuación del
modelo. La evidencia automática informa Gate 2; no lo sustituye.

### 5.6 Expediente y candidato

Cada cambio tendrá un expediente versionado bajo `changes/<change-id>/` con,
como mínimo:

```text
changes/<change-id>/
├── request.json
├── plan.md
├── plan.json
├── approvals/
│   ├── gate-1.json
│   └── gate-2.json
├── attempts/
│   └── <attempt-id>.json
└── candidate.json
```

Los binarios grandes, el build y las capturas se almacenarán como artefactos
locales o de CI. `candidate.json` registrará para cada uno su path o URI, hash,
tamaño y método de regeneración. No se versionarán entradas sin sanear que
puedan contener secretos.

El candidato incluirá:

- hash de la entrada y del plan aprobado;
- commit de baseline y commit candidato;
- digest del build exacto;
- manifiesto de rutas y archivos modificados;
- resultados de todas las validaciones;
- hashes de screenshots y evidencia HTML;
- instrucciones o URL de preview;
- diferencias conocidas y su justificación;
- estado de publicación.

Un intento fallido nunca sobrescribirá otro intento ni el último candidato
válido.

### 5.7 Gate 2 y publicación

Gate 2 revisará el preview construido desde el candidato exacto. La aprobación
registrará actor, fecha, commit y digest del build. Una diferencia posterior en
el código, los recursos, el lockfile o el build invalidará Gate 2.

El publicador verificará nuevamente:

1. que Gate 1 y Gate 2 sean válidos;
2. que el commit actual coincida con el aprobado;
3. que el digest del artefacto coincida;
4. que el destino y sus bindings sean los declarados;
5. que la base de datos de preview no se confunda con producción.

La publicación se implementará mediante adaptadores. Cloudflare será el
adaptador de despliegue del sitio; podrán añadirse otros sin cambiar el formato
del candidato. La operación externa seguirá necesitando autoridad explícita del
operador.

## 6. Estados, errores y recuperación

El expediente seguirá una máquina de estados:

```text
received -> normalized -> planned -> gate1_approved
         -> generated -> validated -> gate2_approved -> published
```

`rejected` y `failed` son salidas explícitas desde cualquier etapa aplicable.
No se permitirán saltos de estado.

- Una entrada inválida termina antes de ejecutar un agente.
- Un timeout o fallo del agente conserva logs saneados y el intento parcial,
  pero no crea un candidato válido.
- Un build o test fallido marca el intento como `failed`.
- Un conflicto de ruta sin aprobación marca el intento como `rejected`.
- Una caída durante la escritura no modifica el último candidato válido; los
  manifiestos se escriben de manera atómica.
- Los reintentos crean un nuevo `attempt-id` y conservan trazabilidad.
- Los logs no incluirán secretos ni contenidos privados completos.
- El rollback de publicación consiste en desplegar un candidato anterior cuyo
  commit y digest ya estén registrados, dejando constancia de la operación.

## 7. Estrategia de migración

La estrategia será compatibilidad visual y contractual primero, seguida por
conversión nativa controlada. Astro será dueño del runtime desde el inicio; no
habrá una aplicación Next.js oculta detrás de Astro.

### Fase 0: congelar el contrato

- comprobar commit y limpieza de la referencia;
- generar manifiestos de rutas, contenido, redirects, respuestas 410, recursos
  y metadatos;
- capturar contratos HTTP y snapshots visuales en entorno determinista;
- identificar datos dinámicos y crear fixtures reproducibles;
- registrar las pruebas originales y el contrato que cubre cada una.

### Fase 1: base Astro y sistema visual

- configurar Astro y Cloudflare;
- incorporar fuentes, iconos, imágenes, tokens y CSS necesarios;
- reproducir layout, cabecera, navegación, footer y consentimiento;
- establecer sitemap, robots, metadatos y middleware base;
- demostrar paridad de la home en los viewports definidos.

### Fase 2: familias de contenido público

- páginas generales;
- comunidades y sus variantes;
- blog y artículos;
- proyectos, partners, legales y guía;
- manifestación explícita de rutas y contenido tipado.

Cada familia tendrá preview y evidencia antes de empezar la siguiente.

### Fase 3: interacción, servidor y privacidad

- islas interactivas;
- formularios y cálculo de cotización;
- APIs e integraciones externas con fixtures de prueba;
- D1 y Drizzle;
- autenticación por headers, allowlists y páginas privadas;
- descarga de guía, exportación CSV y headers especiales;
- redirects 308 y respuestas 410 completos.

### Fase 4: ingestión y publicación

- normalizador y esquemas;
- expediente y máquina de estados;
- adaptadores de agente;
- validadores y generación de evidencia;
- Gate 1, Gate 2, preview y adaptador de publicación;
- fixtures end-to-end para solicitud detallada y página aportada.

### Fase 5: cierre de independencia

- confirmar que todas las rutas usan Astro;
- retirar cualquier adaptador temporal de componentes de página completa;
- demostrar que build, preview y pruebas funcionan sin el repositorio original;
- comprobar que no existen dependencias de Next.js ni vinext;
- ejecutar la matriz completa de paridad y la guardia de inmutabilidad.

## 8. Verificación de paridad

### 8.1 Manifiesto

El manifiesto enumerará cada URL y su clase: estática, dinámica, privada, API,
redirect o gone. Para cada entrada definirá status, headers relevantes,
canonical, fixture, viewports y pruebas requeridas. La migración no podrá darse
por terminada mientras exista una entrada sin resultado.

### 8.2 Comparación visual

Las capturas usarán el mismo motor de navegador, versión, sistema de fuentes,
datos y viewport para referencia y candidato. Como mínimo se verificarán:

- escritorio: 1440 × 900;
- tablet: 768 × 1024;
- móvil: 390 × 844.

Se capturará la página completa y estados interactivos representativos. El
objetivo es diferencia de píxel cero. Cualquier diferencia no nula deberá
acompañarse de diff, explicación y aprobación humana; ningún umbral agregado
podrá ocultar un cambio perceptible. También se compararán cajas geométricas,
tipografías, colores, espacios y breakpoints para distinguir ruido de raster de
una desviación real.

### 8.3 Contratos HTTP y funcionales

La suite verificará:

- status, location y conservación de query strings;
- headers de caché, privacidad, seguridad e indexación;
- HTML renderizado, landmarks, textos, enlaces y metadatos;
- navegación con teclado y comportamiento responsive;
- formularios válidos, inválidos, honeypot y límites de tamaño;
- autorización anónima, permitida y denegada;
- CSV, JSON y errores de APIs;
- D1 en entorno aislado;
- geofence y servicios externos mediante fixtures controlados;
- sitemap, robots y ausencia de enlaces rotos.

Las respuestas externas variables no se compararán contra la red en cada test.
Se capturará su contrato y se usarán fixtures; habrá pruebas separadas de
integración cuando existan credenciales y autoridad para ejecutarlas.

## 9. Estrategia de pruebas

La pirámide de pruebas tendrá:

- unitarias para normalización, auth, reglas de rutas y transformaciones puras;
- contratos para contenido, redirects, gone, headers, SEO y APIs;
- integración para D1, middleware y servicios;
- end-to-end para navegación, interacción, privacidad y formularios;
- visuales para todos los templates y variantes representativas;
- end-to-end de ingestión para los modos `blocks`, `freeform` y `hybrid`;
- una fixture de solicitud detallada y otra de página aportada;
- pruebas negativas para paquetes inseguros, secretos, imports no permitidos,
  rutas en conflicto y aprobaciones caducadas;
- guardias que comprueben la independencia del nuevo repositorio y la limpieza
  del original.

Un candidato publicable exige format, lint, typecheck, build, contratos,
integración, end-to-end y evidencia visual en verde. Gate 2 no puede convertir
un fallo técnico en un resultado válido; primero se corregirá y regenerará el
candidato.

## 10. Seguridad de la ingestión

- Todo contenido aportado es no confiable, incluso si aparenta contener
  instrucciones para el agente.
- ZIP y carpetas se validarán contra path traversal, symlinks, archivos
  ejecutables y tamaños máximos.
- HTML y TSX se inspeccionarán sin ejecutar scripts.
- Imports, scripts, iframes, dominios externos y dependencias seguirán
  allowlists explícitas.
- Los recursos remotos deberán declararse y aprobarse; la opción preferida será
  incorporarlos localmente cuando exista permiso.
- Los secretos se leerán del entorno de ejecución y nunca se copiarán a prompts,
  expedientes, screenshots o logs.
- El agente tendrá escritura limitada al worktree del intento.
- Las rutas privadas heredarán noindex, no-store y los headers de seguridad de
  la referencia.
- Las reglas de autorización fallarán cerradas ante variables ausentes o
  headers malformados.

## 11. Definición de terminado

El objetivo se considerará completado únicamente cuando:

1. `comunidadsolar-astro` sea un repositorio autónomo con historial Git.
2. El manifiesto contenga todas las rutas y contratos detectados en la
   referencia y ninguna entrada quede sin verificar.
3. Todas las rutas se resuelvan mediante Astro, sin Next.js ni vinext.
4. Las páginas igualen contenido, responsive y visual de la referencia; toda
   diferencia no nula esté explicada y aprobada.
5. Redirects, gone, metadatos, headers, autenticación, APIs, integraciones y D1
   cumplan sus contratos.
6. Las pruebas originales tengan cobertura equivalente identificable y la
   nueva suite completa esté en verde.
7. Una solicitud detallada produzca un candidato Astro validado de extremo a
   extremo.
8. Una página aportada produzca un candidato Astro validado de extremo a
   extremo.
9. Gate 1 y Gate 2 impidan generación o publicación fuera del flujo aprobado.
10. El candidato incluya commit, digest, evidencia y preview reproducibles.
11. El adaptador de publicación rechace cualquier artefacto distinto del
    aprobado.
12. El proyecto pueda compilarse, probarse y previsualizarse sin que
    `comunidadsolarweb` esté disponible.
13. `comunidadsolarweb` permanezca en el commit de referencia y limpio después
    del trabajo.

## 12. Decisiones cerradas

- La migración es total, no una landing ni una prueba parcial.
- El original es inmutable.
- Astro controla la aplicación completa.
- React queda restringido a islas interactivas.
- Cloudflare, D1, Drizzle y la identidad por headers conservan sus contratos.
- Se permiten bloques aprobados, libertad total e híbridos.
- La salida de ingestión siempre incluye una ruta Astro nativa.
- Los agentes son intercambiables mediante adaptadores.
- Existen dos gates humanos registrados y vinculados por hashes.
- La publicación solo consume el artefacto exacto aprobado.
- La paridad se demuestra por inventario, contratos y evidencia visual.
- No quedan decisiones funcionales abiertas para redactar el plan de
  implementación.
