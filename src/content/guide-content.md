# Manual estratégico y de implementación de la web de Comunidad Solar

**Actualizado:** 31 de julio de 2026  
**Estado:** documento vivo y obligatorio para cada cambio  
**Ámbito:** estrategia, producto, contenidos, experiencia, datos, integraciones, validación y publicación  
**Destinatarios:** Dirección, Tecnología, Marketing, Comercial, Atención al Comunero y proveedores de desarrollo  
**Fuente única:** `app/guide-content.md`
<!-- site-source-fingerprint: sha256:60aa69c7805d8663105b9b95c0c87f34332131ec7705bb367e5ccd1f4ee4a461 -->

---

## 0. Para qué sirve este documento

Este manual reúne las decisiones que explican la web de Comunidad Solar y las instrucciones necesarias para mantenerla. Su función es evitar que estrategia, comunicación, producto, contratos, datos y desarrollo evolucionen por separado.

No es una memoria de diseño ni una colección de textos antiguos. Es el handoff operativo para que cualquier persona del equipo pueda entender:

- qué relato debe transmitir la web;
- qué función cumple cada página;
- qué puede afirmarse comercialmente y qué necesita validación;
- qué datos alimentan cada ficha;
- a qué herramienta lleva cada CTA;
- qué está resuelto y qué sigue pendiente;
- qué controles deben superarse antes de publicar.

### Cómo debe utilizarse

- **Dirección y Producto:** para comprobar que una nueva decisión respeta la estrategia y los compromisos reales.
- **Marketing y Contenidos:** para escribir a clientes, no al equipo, y no contradecir condiciones, contratos o estados de proyecto.
- **Tecnología:** para saber qué fuentes, recorridos, enlaces, integraciones y controles debe conservar cada implementación.
- **Comercial:** para entender qué expectativa crea cada página y qué información debe poder explicar después.
- **Atención al Comunero:** para distinguir captación, contratación, servicio, suministro y seguimiento.
- **Responsable de publicación:** para aplicar la lista de aceptación y comprobar que el manual también se ha actualizado.

### La pregunta que ordena toda la experiencia

La web debe ayudar a cada persona a responder, en este orden:

1. ¿Qué solución puede llegar realmente hasta mí?
2. ¿Quiero invertir para maximizar el ahorro o prefiero empezar sin inversión?
3. ¿Qué comunidad, proyecto o servicio concreto me corresponde?
4. ¿Qué recibo, qué pago, durante cuánto tiempo y cuál es el siguiente paso?

---

## Regla de sincronización

La página protegida `/guia-equipo` y el archivo descargable protegido `/guia-equipo-nueva-web-comunidad-solar.md` proceden de esta misma fuente. No se mantienen dos copias ni se entrega el contenido a visitantes sin autorización.

### Regla obligatoria para cada cambio

Todo cambio que afecte a contenido público, producto, ruta, CTA, formulario, integración, dato, estado, imagen, diseño, analítica, privacidad, SEO o comportamiento debe incluir en esta fuente:

1. la decisión nueva o modificada;
2. su efecto sobre las páginas o recorridos afectados;
3. la actualización del registro de cambios;
4. la fecha de revisión cuando la modificación altere condiciones o información comercial.

La compilación comprueba que cualquier cambio relevante de la web incluya una modificación de este manual. Si no la incluye, la publicación se detiene.

### Qué se actualiza automáticamente

- La página de lectura y el `.md` descargable siempre muestran exactamente el mismo contenido.
- Los recuentos de páginas base, comunidades, proyectos Remoto, historias y rutas totales se calculan desde los datos reales de la web.
- El manual no aparece en la navegación pública. El equipo autorizado accede directamente a su ruta.
- Las comprobaciones automáticas verifican que página y descarga fallan cerradas para visitantes anónimos y cuentas no autorizadas.

### Qué exige criterio humano

Una automatización puede detectar que ha cambiado una fuente, pero no puede explicar por sí sola por qué cambia una promesa, un contrato o un recorrido. Por eso cada cambio debe añadir una explicación útil, no un simple ajuste de fecha o espacio.

---

## 1. Resumen ejecutivo

La web se construye sobre una idea:

> **Producir cerca. Almacenar mejor. No dejar a nadie fuera.**

La misión de Comunidad Solar sigue siendo devolver la energía a las personas. El camino se adapta a un mercado en el que mucha producción solar coincide en las mismas horas, el valor de esa energía cambia y los costes de red continúan formando parte de la factura.

La nueva etapa se apoya en tres decisiones:

1. **Acercar:** priorizar Comunidades Energéticas de proximidad.
2. **Almacenar:** incorporar baterías donde mejoren el aprovechamiento de la energía o aporten un respaldo útil.
3. **Abrir:** ofrecer compra y alquiler para que la inversión inicial no sea una barrera.

Autoconsumo Remoto sigue siendo una solución propia y nacional. No se presenta como un producto abandonado ni como una inversión de corto plazo. Torrontera se explica como una compra anticipada de energía a 40 años que reduce la exposición futura a una parte del coste energético.

La web debe transmitir simultáneamente:

- **independencia:** Comunidad Solar no pertenece a un gran grupo eléctrico;
- **pertenencia:** detrás de los productos existen comuneros, proyectos, visitas y una historia común;
- **proximidad:** cuando existe cobertura, producir cerca reduce transporte y mejora el modelo;
- **accesibilidad:** compra y alquiler permiten llegar a perfiles distintos;
- **seguridad:** cada producto se explica con activos, responsables, condiciones y pruebas concretas;
- **transparencia:** no se confunden estimaciones con garantías ni estados técnicos con disponibilidad comercial;
- **capacidad operativa:** comercializadora, Helios, captación, cobros y atención forman un sistema completo.

---

## 2. Principios que no se deben romper

### 2.1 Todo texto público habla con un cliente

No pueden aparecer frases de demo, notas de trabajo, instrucciones al redactor o fórmulas propias de una base de datos.

Expresiones como `estado técnico no publicado`, `paneles publicados`, `inventario actual`, `la ficha explica`, `según la cifra corporativa publicada` o `la oportunidad llegará ordenada al equipo` no son lenguaje comercial.

Cuando falta un dato, la página explica la situación que vive la persona:

- `Estado técnico no publicado` se convierte en **La instalación está en preparación y todavía no suministra energía**.
- `Inventario actual` se convierte en **Plazas disponibles**.
- `Precio publicado` se convierte en **Precio por panel, IVA incluido**, si el dato está confirmado.
- `Proyecto completo` se convierte en **La comunidad está completa; comprobaremos si existe otra opción cercana**.

El último control editorial siempre es esta pregunta:

> **¿Se lo diríamos así a un cliente cara a cara?**

### 2.2 Las personas antes que el producto

La dirección y la situación real determinan primero qué puede recibir una persona. Solo después se recomienda Comunidad Energética, Autoconsumo Remoto, instalación en tejado, batería u otra solución.

### 2.3 Primero cobertura; después propuesta

La comprobación inicial debe ser sencilla. La nueva calculadora de Comunidades Energéticas recoge la información necesaria y construye el recorrido; la web no debe duplicar una falsa calculadora ni una simulación sin conexión.

### 2.4 Compra y alquiler no se mezclan

No son dos precios del mismo producto:

- **Compra:** inversión inicial para recibir producción durante el plazo contractual y maximizar el ahorro potencial.
- **Alquiler:** sin inversión inicial, con cuota mensual, menor ahorro estimado y condiciones propias.

La página puede compararlos, pero los CTA, importes, duración, responsabilidades y expectativas deben permanecer separados.

### 2.5 No se inventan datos

Si potencia, precio, calendario, disponibilidad o modalidad no están confirmados, la web explica que se confirmarán antes de contratar. No se muestra un campo de base de datos vacío ni se improvisa una cifra.

### 2.6 Una sola fuente por dato

Mapa, tarjeta, ficha, resultado de cobertura y CTA no pueden mantener versiones distintas de potencia, plazas, estado o modalidad. Hoy las páginas utilizan fuentes compartidas dentro del proyecto; la evolución debe conectarlas con CRM y Helios sin romper esa unidad.

### 2.7 Las cifras comerciales llevan contexto

Un porcentaje, precio o plazo nunca aparece sin producto, hipótesis y alcance. `0 €/kWh` no equivale a factura cero. `Hasta un 70 %` no es una garantía universal. `49 €/mes` no puede ocultar entrada, plazo, interés o coste total.

### 2.8 La seguridad se demuestra

La confianza no se construye con adjetivos genéricos. Se demuestra con:

- activos reales;
- contratos coherentes con la comunicación;
- explicación de quién opera, mantiene, asegura, instala o factura;
- facturas y ejemplos que se entienden;
- testimonios con fuente y contexto;
- fechas, hitos, proyectos y personas reales;
- registro oficial de la comercializadora.

### 2.9 Lo histórico y lo vigente se distinguen

Fuente Álamo, Ligüérzana, vídeos, facturas y apariciones en medios ayudan a demostrar trayectoria. No deben trasladar automáticamente al producto actual precios, rentabilidades, garantías o plazos de otra generación.

### 2.10 Comercial y Atención no se confunden

- Los asesores ayudan a informarse, comprobar encaje y contratar.
- Atención al Comunero ayuda a quien ya forma parte de Comunidad Solar con proyecto, suministro, factura o incidencia.

Los dos recorridos deben estar identificados y disponer de sus canales propios.

### 2.11 La web no replica la app

La app es la puerta del comunero para producción, consumo, ahorro, facturas, contratos y documentación. La web la hace visible y ofrece acceso al portal de Atención, pero no almacena ni recrea esa información.

### 2.12 Las condiciones contractuales mandan

La página es comercial y no necesita reproducir cláusulas. Sí debe evitar cualquier contradicción con lo que se firma: naturaleza del producto, duración, instalación, costes, mantenimiento, seguro, cambio de comercializadora, cesión y tratamiento de la energía.

### 2.13 La información privada se protege en servidor

Una URL difícil de adivinar, `noindex` o un botón de acceso no protegen información estratégica.

- `/socios` exige identidad individual y autorización explícita por correo.
- `/guia-equipo` y su descarga exigen una autorización de equipo independiente.
- Si no existe configuración, el acceso falla cerrado.
- Contenido, documentos, listas de correos y reglas de autorización permanecen en módulos de servidor.
- Nada privado se publica en `public/`, JSON estático, componentes cliente o analítica.
- Una contraseña compartida no sustituye el acceso individual porque no identifica ni permite revocar a una persona concreta.

---

## 3. Audiencias y siguiente paso

| Audiencia | Pregunta principal | Respuesta de la web | CTA natural |
|---|---|---|---|
| Hogar o negocio | ¿Tengo cobertura próxima? | Dirección, comunidad, modalidad, estado y plazas | Comprobar mi cobertura |
| Persona que quiere invertir | ¿Qué parte de mi energía puedo dejar resuelta? | Compra, producción, plazo, costes y escenarios | Calcular mi propuesta |
| Persona que no quiere invertir | ¿Puedo ahorrar sin desembolso? | Alquiler, cuota, energía asignada y condiciones | Ver si puedo alquilar |
| Persona sin cobertura | ¿Qué alternativa existe? | Lista de espera, otra comunidad, Remoto o tejado | Dejar interés o comparar |
| Cliente de Remoto | ¿Qué compro y cómo llega a la factura? | Energía anticipada, instalación, coincidencia, cuotas y monedero | Calcular Torrontera |
| Cliente de instalación | ¿Cómo aprovecho mejor mi tejado? | Diseño, consumo, batería, equipos, obra y garantías | Solicitar estudio |
| Comunero actual | ¿Dónde veo mi energía o pido ayuda? | App y portal identificado de Atención | Soy comunero |
| Propietario de cubierta | ¿Cómo rentabilizo el espacio? | Desarrollo, financiación, alquiler y gestión | Solicitar estudio |
| Propietario de planta | ¿Quién gestiona y comercializa la producción? | Captación, reparto, comercializadora, cobros y Helios | Estudiar planta |
| Socio fundador | ¿Dónde estamos, qué cambia ahora y cuáles son los próximos hitos? | Resultados, agenda, roadmap, financiación, equipo y biblioteca societaria | URL privada comunicada individualmente |
| Futuro empleado, socio o medio | ¿Es una compañía real? | Historia, proyectos, equipo, comunidad y actividad | Quiénes somos o Blog |

---

## 4. Arquitectura de información actual

La web documenta **{{TOTAL_CONTENT_ROUTES}} rutas de contenido**:

- **{{BASE_PAGE_COUNT}} páginas base**, incluida esta guía;
- **{{COMMUNITY_PAGE_COUNT}} fichas de Comunidades Energéticas**;
- **{{REMOTE_PROJECT_COUNT}} proyectos de Autoconsumo Remoto**;
- **{{BLOG_STORY_COUNT}} historias del Blog**.

### Páginas base

| Ruta | Función actual | Regla principal |
|---|---|---|
| `/` | Narrativa y elección de camino | No convertir la portada en un catálogo |
| `/nosotros` | Historia, misión, legado y plan | Abrir con #PorElPlaneta; presentar la independencia como una consecuencia de la misión |
| `/comunidades-energeticas` | Modelo, cobertura y proyectos | Llevar a la calculadora pública correcta |
| `/comunidades-energeticas/manganafer` | Campaña territorial, zona de 1 km y registro de interés | Presentar primero el beneficio para los vecinos inmediatos; el mapa es orientativo y la elegibilidad se confirma con el CUPS |
| `/autoconsumo-remoto` | Producto nacional y Torrontera | Explicar antes de pedir una decisión |
| `/autoconsumo-en-mi-tejado` | Instalación fotovoltaica | Valorar la batería desde el diseño |
| `/baterias` | Batería doméstica SolaX | Servir a hogares con o sin placas |
| `/aerotermia` | Aerotermia con Coolfy | Identificar claramente al partner |
| `/rentabiliza-tu-activo` | Cubiertas y plantas de terceros | Separar los dos tipos de activo |
| `/comunidades-energeticas-operativas` | Operación de plantas construidas de terceros | Explicar el modelo completo y cualificar el activo |
| `/blog` | Comunidad, proyectos y memoria | Mantener fecha, contexto y fuente |
| `/eventos` | Agenda pública común de encuentros y webinars | Publicar solo citas confirmadas o celebradas y enlazar su fuente original |
| `/soy-comunero` | App y Atención al Comunero | No duplicar funciones privadas |
| `/contacto` | Captación y servicio separados | Llevar a cada público a su canal |
| `/comercializadora-y-tarifas` | Acceso, tarifas y factura | No presentar Megapark como contratable |
| `/mantenimiento` | Servicio recomendado de Solaico | Contratación y prestación directas |
| `/politica-privacidad` | Política de privacidad vigente | Conservar el texto literal y su URL histórica |
| `/cookies` | Política de cookies vigente | Conservar el texto literal y enlazar el configurador real |
| `/aviso-legal` | Aviso legal vigente | No corregir ni reinterpretar sin validación jurídica expresa |
| `/terminos-y-condiciones` | Condiciones de contratación vigentes | No corregir ni reinterpretar sin validación jurídica expresa |
| `/socios` | Información estratégica anticipada para socios fundadores | Acceso individual, agenda fechada y certeza explícita |
| `/manganafer/interesados` | Base privada de personas interesadas en Manganáfer | Acceso individual y exportación protegida; nunca exponer datos personales en la web pública |
| `/guia-equipo` | Estrategia e implementación | Acceso interno; fuente común protegida |

### Plantillas dinámicas

- Las fichas de Comunidades Energéticas proceden de `app/community-data.ts`.
- Las fichas de Remoto proceden de `app/remote-project-data.ts`.
- Las historias proceden de `app/blog-data.ts`.
- La agenda pública curada procede de `app/events-data.ts`.
- Mapa, tarjetas, fichas, proyectos relacionados y sitemap reutilizan esas fuentes.

### Navegación actual

- **Soluciones**
  - Comunidades Energéticas
  - Autoconsumo Remoto
  - Instalación fotovoltaica
  - Baterías
  - Aerotermia
  - Mantenimiento
  - Comercializadora y tarifas
- **Para propietarios**
  - Tengo una cubierta
  - Tengo una planta
- **Quiénes somos**
- **Blog**
- **Eventos**

El pie incorpora las cuatro rutas legales nativas. **Configurar cookies** no es
otra página: abre el gestor de preferencias desde cualquier ruta.
- **Contacto**
- **Soy comunero**
- **Comprueba tu cobertura**

El cargador de coche eléctrico se ha retirado de navegación, portada, pie, páginas de producto y sitemap. Su URL histórica responde como contenido retirado y no debe reaparecer sin una decisión de producto nueva.

### Rutas históricas y legales

- Las rutas antiguas útiles redirigen a su equivalente nuevo.
- `/comunidades-energeticas-operativas` conserva su URL histórica y vuelve a ser una página nativa; no redirige a una sección resumida.
- Servicios retirados responden con estado de contenido eliminado y `noindex`.
- Las páginas legales continúan enlazadas temporalmente a la web corporativa vigente. Antes de sustituir el dominio principal deben existir nativamente o confirmarse como destinos definitivos.
- `/socios`, `/guia-equipo` y la descarga `.md` usan autenticación, autorización de servidor, caché privada y `noindex`.
- La guía y el área de socios no se enlazan desde ninguna página pública. La URL de socios se comunica individualmente a las personas autorizadas.

---

## 5. Decisiones página por página

### 5.1 Home

Objetivo: contar hacia dónde evoluciona Comunidad Solar y ayudar a elegir sin saturar.

En los accesos generales a la calculadora de cobertura se conserva el titular
**¿Hay una comunidad energética cerca de ti?**, pero no se añade un párrafo
introductorio debajo: la explicación completa ya vive dentro de la propia
calculadora. Así se evita repetir el mismo mensaje y el bloque queda más
compacto. Las fichas de comunidades concretas sí mantienen su breve contexto
específico cuando es necesario explicar cobertura, lista de espera o
participación completa.

#### Hero de la home

La home prueba de forma deliberada la **versión B de la opción 1, «España conectada»**, en su hero. El experimento se limita al contenido del primer pantallazo y termina antes de `TrustBand`; la ordenación posterior responde al recorrido comercial de la portada y no forma parte del experimento. La opción 3 queda preservada en el historial como versión anterior reversible.

La home mantiene la cabecera corporativa completa de las páginas interiores: la franja superior con **Energía independiente desde 2018** y **La energía de las personas**, el logo corporativo (`/comunidad-solar-logo.svg`), la navegación, el acceso de comuneros y el CTA **Comprueba tu cobertura**.

El hero va a sangre, sin contenedor, esquinas ni sombra. Recupera el paisaje territorial al atardecer, el titular **La energía vuelve a manos de las personas**, el texto breve de la propuesta, los dos CTA rectangulares, una ruta energética luminosa y un mapa esquemático de España. Desde la batería, la ruta se bifurca para bordear los dos lados del parque solar y vuelve a reunirse antes de entrar en el pueblo, evitando cruzar visualmente los paneles. Al llegar al cruce principal se divide en tres ramales que siguen las direcciones de las calles; cada ramal termina en un pequeño nodo de reparto con tres derivaciones hacia viviendas concretas. La escena conecta visualmente nueve casas, sin finales sobre calles o vegetación y sin convertirse en una maraña de líneas. Para evitar que las rutas se desalineen del paisaje cuando la imagen cambia mucho de recorte, se ocultan por debajo de 980 píxeles.

La tarjeta del mapa nunca debe presentar una comunidad concreta como si la home corporativa perteneciera a ese municipio. Funciona como acceso general a **Nuestra red en España**, muestra automáticamente el número de comunidades publicadas y lleva al inventario completo de `/comunidades-energeticas#proyectos`, donde se pueden consultar ubicación, estado y ficha. El CTA principal del hero continúa llevando a la comprobación de cobertura. Así el primer pantallazo habla de la red completa y sigue siendo válido aunque cambien los estados o la potencia de un proyecto individual.

Debajo de los botones aparece una única línea de prueba con tres mensajes: **Más de 3.500 personas y empresas**, **Independientes de grandes grupos** y **Compra o alquiler**. Textos, botones, logo, mapa, tarjeta y conexiones se construyen como capas reales de la web; no están incrustados en la fotografía y deben seguir siendo legibles, indexables, accesibles y actualizables. En móvil, los tres mensajes se apilan y el mapa se oculta para mantener la lectura.

La imagen de producción es `/media/home-hero-option-1-spain-connected-1024x792.png`: una escena conceptual de 1024×792 con un pueblo español, montañas, planta solar, batería estacionaria y luz dorada. Debe conservarse luminosa; el contraste para el texto se resuelve con un degradado verde localizado desde la izquierda, no oscureciendo toda la escena. Nunca se atribuye a una ubicación o proyecto real.

La banda de confianza completa que sigue al hero deja una franja blanca superior de 34 píxeles, equilibrada visualmente con la franja inferior que contiene la nota de verificación. Por defecto, las bandas compactas de las páginas interiores mantienen su composición; la única excepción es la página de plantas operativas en escritorio, documentada en su apartado.

Debe conservar:

- protagonismo de las Comunidades Energéticas;
- el relato proximidad, almacenamiento y acceso;
- compra y alquiler diferenciados;
- Torrontera como alternativa nacional cuando no existe cobertura;
- servicios del hogar en segundo nivel;
- proyectos, comuneros, reseñas, registro CNMC, historias y personas como pruebas;
- la comprobación de cobertura como primera puerta comercial después de la banda de confianza;
- el giro estratégico antes de presentar los tres mundos;
- un bloque de elección con **Comunidad Energética**, **Autoconsumo Remoto** e **instalación en tu tejado**, en ese orden;
- un bloque visible de apariciones en medios inmediatamente después de esos tres mundos;
- un bloque humano que permita hablar con un asesor;
- acceso visible para quien ya es comunero.

La secuencia inicial de la portada es: hero, confianza, comprobación de
cobertura, giro estratégico, tres mundos y medios. La comprobación de cobertura
permanece arriba porque es el mejor punto de partida: si la dirección no tiene
una comunidad cercana, el recorrido continúa hacia otra comunidad,
Autoconsumo Remoto o una solución en el propio tejado. El bloque de los tres
mundos no separa compra y alquiler como si fueran mundos distintos; ambas son
formas de participar dentro de Comunidad Energética.

No debe recuperar:

- listados de productos sin jerarquía;
- promesas genéricas de factura cero;
- formularios simulados;
- logotipos de medios presentados como aval;
- caras generadas para representar al equipo.

### 5.2 Quiénes somos

Objetivo: explicar por qué existe Comunidad Solar y por qué puede cumplir su misión.

Secuencia:

1. promesa intergeneracional **«La energía que elegimos hoy cambia el mundo que dejamos mañana»**;
2. campaña y firma **#PorElPlaneta**;
3. Damián Villa, comunero real desde 2021, y el vídeo **«Hay decisiones que iluminan el futuro»**;
4. origen entre amigos y primer panel;
5. fundación en 2018 y más de 3.500 comuneros como cifra corporativa viva;
6. misión de acercar energía limpia a más personas y dejar un sistema mejor a quienes vienen detrás;
7. plan de acercar, almacenar y abrir;
8. capacidades: energía, Helios, comercializadora, captación y atención;
9. independencia de los grandes grupos como garantía de libertad para cumplir la misión;
10. principios de actuación.

No se reconstruye una página de misión separada que duplique el relato.

El hero de `/nosotros` reutiliza sin modificaciones la cabecera corporativa
compartida por la web. La imagen procede del fotograma oficial del vídeo de
Comunidad Solar en Vimeo y muestra al Damián real; no debe sustituirse por una
persona generada ni por una recreación de sus rasgos. El vídeo se carga solo
cuando el visitante decide reproducirlo y debe mantener cierre accesible,
tecla Escape y alternativa de movimiento reducido.

### 5.3 Comunidades Energéticas

Objetivo: explicar energía de proximidad, comprobar cobertura y mostrar instalaciones concretas.

Reglas:

- El hero abre con el beneficio **«Ahorra en tu factura»** y muestra una cubierta de colegio compartiendo energía con su entorno; la proximidad apoya la promesa, no la sustituye.
- Radio público: **Hasta 5 km**, sujeto a la comprobación del punto de suministro y del proyecto.
- Compra y alquiler aparecen como modelos diferentes.
- La compra puede comunicar **hasta un 70 % de ahorro estimado** cuando la hipótesis y el proyecto lo permiten.
- El alquiler comunica el rango validado para la comunidad concreta; no hereda automáticamente la cifra de otra instalación.
- Cada ficha separa estado de obra, conexión, legalización, energía en factura y situación comercial.
- Una instalación conectada no implica que la energía ya aparezca en las facturas.
- Las fichas hablan con clientes y no muestran nombres de campos internos.
- Las comunidades completas conducen a cobertura o alternativa, no a un callejón sin salida.
- Cada comunidad utiliza una imagen local propia. Se prioriza la simulación o fotografía de su cubierta; cuando no existe una imagen válida, se utiliza una vista real y reconocible del municipio.
- Nunca se repite una imagen genérica entre localidades diferentes ni se enlazan directamente recursos temporales del mapa antiguo.
- El texto alternativo distingue con claridad una simulación del proyecto de una fotografía representativa de la localidad.
- La llamada principal abre `https://calculadoraenergetica.comunidadsolar.es`.
- Está prohibido recuperar enlaces con `interno-asesores=true` o formularios antiguos de Helios.

Estructura recomendada de una ficha:

1. nombre, municipio e imagen real;
2. qué puede hacer hoy la persona;
3. modalidad y cobertura;
4. estado comprensible;
5. datos confirmados de instalación;
6. hitos y siguiente paso;
7. otras comunidades cercanas o calculadora.

#### Campaña territorial de Manganáfer

`/comunidades-energeticas/manganafer` no funciona como una ficha técnica ni
como una contratación. Es una landing para medir el interés de vecinos,
hogares y pequeños negocios y construir una conversación directa con el
territorio.

El mensaje parte de **«Si forma parte de tu paisaje, también debería formar
parte de tus beneficios»** y responde de forma serena a las preocupaciones
locales sin señalar, citar ni desacreditar a ninguna persona o colectivo. Debe
reconocer que las preguntas sobre el paisaje y el territorio son legítimas,
ofrecer información directa y devolver siempre el foco a lo que puede recibir
el vecino.

En esta fase se comunican únicamente los beneficios previstos:

- prioridad para suministros situados a un máximo de 1 kilómetro del proyecto;
- objetivo de hasta un 50 % de descuento durante las horas solares;
- ausencia de obras en la vivienda o negocio;
- ausencia de inversión inicial;
- objetivo de beneficio durante 25 años.

El límite de 1 kilómetro se comunica como un beneficio reservado a quienes
conviven más cerca con el proyecto, nunca como una comparación con el radio de
otras comunidades energéticas. La propuesta se dirige únicamente a hogares y
pequeños negocios cuyo punto de suministro esté a un máximo de 1 kilómetro. La
landing muestra un mapa local vectorial y deliberadamente orientativo, con el
proyecto, el halo de proximidad y referencias cercanas. No debe presentarse
como una delimitación catastral ni como confirmación de cobertura.

La descripción al compartir la URL repite literalmente la frase fuerza del
hero: **«Si forma parte de tu paisaje, también debería formar parte de tus
beneficios»**. El dato de 1 kilómetro se explica dentro de la página, no en la
vista previa social.

La comprobación definitiva se realizará mediante el CUPS en la calculadora
energética de Comunidad Solar. La integración reutiliza su mismo backend de
quoting mediante `/api/manganafer-quote`; no construye fórmulas comerciales
paralelas en el navegador. Esta ruta recibe el CUPS por `POST`, consulta
servidor a servidor sus datos, confirma la distancia máxima de 1 kilómetro y
compara varias asignaciones de paneles para mostrar solo una combinación con
ahorro positivo.

El CUPS nunca debe incluirse en la URL pública, enviarse a analítica, registrarse
en logs ni guardarse en la base de interesados. La consulta servidor a servidor
respeta el contrato técnico del servicio actual y la respuesta pública devuelve
solo elegibilidad, distancia aproximada y cifras agregadas de la estimación.

La calculadora permanece oculta y el formulario de interés continúa siendo la
vía pública hasta que estén configurados el token privado del quoting y todos
los parámetros comerciales validados de Manganáfer: cuota por panel, cuota sin
IVA, IVA, cupo, producción anual por panel, descuento, potencia del módulo y
degradación. Ninguno de estos valores ni el token se fija de forma provisional
en el código.

La página no explica todavía de qué instalación concreta procederá la energía
ni cuál será su arquitectura técnica. Tampoco publica una vía específica para
proponer cubiertas. Esos detalles se comunicarán cuando estén confirmados y sea
el momento adecuado.

Todas las cifras se presentan como objetivos provisionales. El registro es
gratuito y sin compromiso; no garantiza plaza, cobertura, calendario ni
condiciones. La persona podrá conocer las condiciones definitivas y decidir
libremente antes de cualquier contratación.

El formulario guarda nombre, apellidos, correo, teléfono, municipio o
diputación, código postal, zona aproximada, perfil y mensaje. Los registros
solo se consultan en `/manganafer/interesados`, protegida mediante identidad
individual y lista de correos autorizados, y pueden exportarse como CSV desde
esa misma área.

### 5.4 Autoconsumo Remoto

Objetivo: conseguir que una solución poco habitual se entienda y, después, transmitir seguridad.

La secuencia comercial es:

1. definir el producto en lenguaje sencillo;
2. mostrar Torrontera como propuesta disponible;
3. explicar el horizonte de 40 años;
4. enseñar cómo se refleja en una factura;
5. explicar seguridad, operación, seguro y transmisión;
6. demostrar trayectoria con Fuente Álamo, Ligüérzana, comuneros y vídeos;
7. pedir una propuesta personalizada.

Mensaje de cabecera:

> **Tus paneles solares no tienen que estar en tu tejado.**

El lenguaje comercial recupera deliberadamente la idea de **“tus paneles a
distancia”**: primero permite visualizar la solución y desearla; después se
aclara con precisión que el contrato es una compra anticipada de la energía
asociada a los paneles identificados en la propuesta, no la adquisición física
de los módulos ni de participaciones sociales de la productora.

En el hero, texto y vídeo se resuelven como una única escena: una masa verde
orgánica abraza el reel, una ruta luminosa conecta visualmente **tus paneles**
con la prueba televisiva y la cartela de Antena 3 se solapa entre ambos lados.
Se evitan el marco rígido de monitor y las capas rectangulares que hacían que
mensaje e imagen pareciesen dos piezas independientes. El movimiento del flujo,
la entrada progresiva y la pulsación son sutiles y se desactivan cuando el
navegador solicita movimiento reducido. En tablet y móvil la composición se
apila, la ruta se oculta y la cartela permanece integrada con el vídeo.

El vídeo-reel de apariciones reales de Comunidad Solar en televisión funciona
como prueba temprana de credibilidad; sus imágenes y mensajes históricos no
alteran las condiciones vigentes de Torrontera. Antes del clic se muestra como
portada el fotograma de Antena 3 con la presentadora y la marca Comunidad Solar,
para que la validación televisiva sea inequívoca desde el primer vistazo. El
reproductor solo se carga cuando la persona decide reproducirlo y la biblioteca
inferior evita duplicar la misma pieza.

No se presenta como rentabilidad rápida. Es una decisión de tranquilidad energética y largo plazo.

### 5.5 Torrontera

Torrontera es la propuesta vigente de Autoconsumo Remoto.

Datos públicos revisados en julio de 2026:

- dos plantas solares en funcionamiento;
- Torrontera I produce desde agosto de 2023;
- Torrontera II produce desde marzo de 2024;
- aproximadamente 2,06 MWp en módulos;
- 3.808 paneles de 540 W;
- 4 MWh de almacenamiento en el parque;
- cerca del 90 % contratado en la revisión de julio de 2026;
- horizonte contractual comercial de 40 años.

Reglas contractuales trasladadas a marketing:

- El cliente realiza una **compra anticipada de energía**, no compra hoy paneles físicos ni participaciones sociales de la productora.
- Cada contrato identifica **una instalación concreta**, aunque la página pueda presentar cifras agregadas de las dos plantas.
- `0,00 €/kWh` solo se refiere al componente de energía producida que coincide con el consumo hora a hora.
- Continúan potencia, peajes, cargos, costes del sistema, impuestos, energía de red no cubierta y cuotas.
- La cuota de mantenimiento y administración comunicada es `1 € + IVA por panel y mes`, actualizable por IPC, según contrato.
- La cuota Comunidad Solar comunicada es `3 € + IVA al mes`, actualizable por IPC, según contrato.
- La energía no aprovechada se vende y su valor neto se lleva al monedero según las condiciones firmadas.
- El suministro no tiene permanencia; si el cliente cambia de comercializadora, el tratamiento económico de la energía pendiente sigue lo pactado en el contrato.
- La cesión exige estar al corriente de pago y el contrato es transmisible a herederos.

La web no debe trasladar las incoherencias internas detectadas en borradores contractuales. Antes de modificar duración, prórrogas, obligación de producción, desistimiento o liquidación debe existir una versión jurídica validada.

### 5.6 Fuente Álamo

Fuente Álamo I y II son activos históricos completos y en funcionamiento:

- dos parques solares;
- aproximadamente 1,03 MWp en módulos;
- 1.903 paneles de 540 W;
- seguimiento solar a un eje;
- sin plazas disponibles.

Su función en la web es demostrar trayectoria, mantener información útil para comuneros y conectar historias reales. No debe presentarse como oferta actual independiente.

### 5.7 Ligüérzana

Ligüérzana es una central hidroeléctrica de 500 kW en el río Pisuerga.

La página explica:

- el caudal mueve la turbina;
- el generador transforma ese movimiento en electricidad;
- la producción varía con caudal, estación y mantenimiento;
- la duración publicada del proyecto es de 30 años;
- el proyecto reúne 2.010 comuneros;
- las participaciones contractuales equivalentes son de 75 W y 100 W;
- el reparto se representa como 3.262 participaciones de 75 W y 2.554 de 100 W, no como turbinas físicas independientes;
- complementó la curva solar de Fuente Álamo;
- el proyecto está completo y sigue produciendo para sus comuneros.

No se habla de miles de miniturbinas, producción constante ni disponibilidad comercial.

### 5.8 Instalación fotovoltaica

Objetivo: diseñar una instalación a partir del consumo, el tejado y los objetivos reales.

Debe explicar:

- estudio de consumo y horarios;
- diseño y equipos;
- montaje, protecciones, legalización y puesta en marcha;
- garantías por elemento, no una garantía genérica;
- posibles trabajos adicionales separados antes de contratar;
- comparación orgánica entre placas solas y placas con batería.

La batería se valora desde el diseño aunque el cliente decida no instalarla.

### 5.9 Baterías

La oferta SolaX X1-IES se dirige a viviendas con o sin placas.

Configuración pública de referencia:

- inversor híbrido SolaX de 5 kW;
- batería de 5,1 kWh de capacidad nominal y 4,6 kWh útiles según fabricante;
- precio publicado de 4.799 € IVA incluido, con 50 % antes y 50 % al finalizar la instalación;
- respaldo sujeto a circuitos, potencia y compatibilidad;
- instalación y legalización dentro del alcance confirmado;
- más de 6.000 ciclos declarados por fabricante bajo sus condiciones de ensayo.

El ejemplo `Desde 49 €/mes` solo puede mantenerse mostrando también:

- 550 € de entrada;
- 120 meses;
- interés anunciado del 6,99 %;
- carácter orientativo y sujeto a aprobación y condiciones vigentes.

No se promete autonomía universal, vida útil exacta ni respaldo de toda la vivienda sin estudio.

### 5.10 Aerotermia

Coolfy es el instalador Premium y partner oficial.

La página debe dejar claro:

- Comunidad Solar recomienda y presenta el servicio;
- Coolfy estudia, dimensiona, presupuesta, instala, pone en marcha y presta el servicio posventa conforme a la propuesta;
- la compatibilidad depende de vivienda, emisores, temperaturas, potencia y ubicación;
- una primera estimación no sustituye la visita técnica;
- el CTA lleva a Coolfy y no simula una contratación interna.

### 5.11 Mantenimiento

Comunidad Solar recomienda el mantenimiento, pero no lo presta ni lo factura.

Solaico, razón social UNIÓN COMPOSITES, S.L.:

- analiza la instalación;
- confirma alcance y precio;
- formaliza directamente el contrato;
- realiza la revisión y factura el servicio.

Reparaciones, piezas, desplazamientos o trabajos extraordinarios solo se consideran incluidos cuando aparecen expresamente en la propuesta de Solaico.

### 5.12 Comercializadora y tarifas

La comercializadora es una ventaja vinculada a la comunidad, no un catálogo abierto de dos tarifas.

**Megapark**

- corresponde a quien contrata Autoconsumo Remoto o Comunidad Energética;
- acompaña al producto energético;
- no se contrata por separado;
- solo debe tener CTA de información sobre el producto que da acceso.

**Megahome**

- puede contratarla quien se realizó una instalación con Comunidad Solar;
- también puede contratarla un invitado de un comunero de Remoto o Comunidad Energética mediante código;
- sí dispone de recorrido de contratación.

La página conserva:

- energía de red sin margen comercial;
- cuota aplicable;
- excedentes y monedero cuando exista producción propia;
- app;
- fuerza colectiva;
- operación con Ingebau;
- inscripción de la comercializadora en el censo CNMC con R2-883.

La factura mostrada es **una representación visual estática y explicada**, no una calculadora. Debe enseñar con claridad:

1. de dónde procede la energía;
2. qué energía propia se aplica;
3. qué energía llega de la red;
4. qué conceptos regulados y cuotas continúan;
5. cómo se aplica el monedero.

El ejemplo actual utiliza 196 kWh de producción propia, 152 kWh de red, 158 kWh no utilizados y un total ilustrativo de 45,07 €. Es una explicación visual, no una oferta ni una previsión de ahorro.

### 5.13 Rentabiliza tu activo

La página general separa dos propuestas y funciona como selector. Cada tarjeta debe dejar claro que los puntos de partida son diferentes.

**Cubierta disponible**

- el propietario aporta un espacio;
- Comunidad Solar estudia, desarrolla, financia, legaliza, capta participantes y opera;
- la remuneración puede acordarse en dinero o energía;
- no se promete una renta estándar sin estudio.

**Planta en funcionamiento**

- se analiza producción, conexión, entorno, contratos y posibilidad de proximidad;
- Comunidad Solar puede aportar captación, contratación, reparto, comercializadora, cobros y atención;
- Helios soporta la operación.
- la tarjeta y el acceso `Tengo una planta` conducen a `/comunidades-energeticas-operativas`;
- el cierre de la página general conserva el formulario directo para quien ya conoce el modelo.

El texto debe dirigirse al propietario. No puede contener instrucciones del tipo `que la oportunidad llegue ordenada al equipo`.

#### Página específica de plantas operativas

`/comunidades-energeticas-operativas` recupera y mejora la propuesta histórica **Activo Conectado**. Se dirige a propietarios, promotores, fondos y operadores con plantas fotovoltaicas construidas, operativas o próximas a entrar en operación, siempre que tengan madurez técnica y administrativa y documentación suficiente para poder evaluarlas.

Tesis:

> **Tú aportas el activo. Comunidad Solar aporta Helios, la comercializadora, la captación de usuarios y la operación diaria.**

El hero adopta la dirección visual **Red de valor** sin crear una cabecera específica: conserva exactamente la franja superior, el logotipo, el menú, los accesos y el comportamiento móvil de la cabecera corporativa compartida. Justo debajo, una escena conceptual luminosa muestra una planta operativa, el pueblo y pequeñas empresas; sobre ella, el nodo Helios conecta visualmente la producción con seis destinos reales. El contraste del texto se resuelve con un velo crema localizado en la izquierda, sin oscurecer el territorio. Una franja inferior resume la secuencia **Activo que ya produce → Plataforma y comercializadora → Demanda de proximidad**.

En escritorio, cuando la banda de confianza muestra sus cuatro datos en una sola fila, deja 34 píxeles de aire blanco por encima de las tarjetas. Replica el equilibrio aprobado en la home sin modificar los tres mensajes del hero, el espaciado de la sección siguiente ni las composiciones de tablet y móvil.

En móvil, la cabecera tampoco cambia y no debe aparecer ningún hueco entre esta y el hero. El bloque de texto se presenta primero sobre crema; debajo aparece la escena con una red simplificada y, después, los tres mensajes en filas. La fotografía y las conexiones son conceptuales y decorativas: el titular, la explicación, los CTA y la síntesis permanecen como contenido HTML accesible.

La secuencia comercial obligatoria es:

1. definir la oportunidad y pedir un análisis de encaje;
2. comparar mercado, PPA, venta del activo y comunidad energética sin afirmar que una solución es universalmente mejor;
3. adelantar una síntesis visual del partnership: planta y mantenimiento por parte del propietario; Helios, comercialización, venta y operación de la comunidad por parte de Comunidad Solar; reparto 80/20 sobre ingresos efectivamente cobrados;
4. explicar el flujo activo → plataforma → usuarios → valor compartido;
5. separar responsabilidades del partner y de Comunidad Solar;
6. explicar Helios por resultados: análisis, oferta, contratación, reparto, factura, cobros, atención y seguimiento;
7. mostrar el proceso completo desde el análisis hasta la operación continuada y dejar claro que detrás hay un equipo humano;
8. explicar que el propietario conserva la propiedad y recibe el 80% de los ingresos efectivamente cobrados, mientras Comunidad Solar recibe el 20% por aportar la plataforma y operar el modelo;
9. precalificar el activo en la página y explicar que el formulario completa la cualificación mediante información técnica y documental detallada.

Reglas comerciales:

- No usar `multiplica el valor`, `alternativa siempre mejor`, ingresos garantizados, ocupación asegurada ni plazos universales.
- La comunidad energética puede cubrir toda la capacidad compatible o solo una parte, según contratos, regulación y demanda.
- La energía todavía no asignada debe tener una salida comercial definida en la propuesta; no se presupone ocupación total desde el primer día.
- No confundir operación comercial, energética y administrativa con el O&M físico de la planta: en este modelo el propietario aporta la planta y se ocupa de su operación y mantenimiento físico; Comunidad Solar opera la comunidad alrededor de ella.
- El reparto estándar validado es 80% para el propietario y 20% para Comunidad Solar, calculado únicamente sobre los ingresos efectivamente cobrados. No presentarlo como reparto de beneficios, margen teórico, energía generada o facturación todavía no cobrada.
- No presentar todavía una conversión de terceros como caso de éxito completo si no existe evidencia pública verificable. Las pruebas actuales son la trayectoria desde 2018, más de 3.500 comuneros, la comercializadora R2-883 y Helios.
- El formulario de plantas operativas es deliberadamente exhaustivo. No debe simplificarse para aumentar el número de contactos: funciona como filtro de madurez y evita dedicar análisis técnico, comercial y regulatorio a oportunidades incompletas.
- El propietario, promotor u operador debe poder aportar información suficiente para acreditar que existe un activo real y evaluable: titularidad o derecho de explotación, documentación técnica, acceso y conexión, permisos y legalización, medida, producción, contratos vigentes y energía disponible.
- La página debe anticipar con claridad este nivel de exigencia y explicar su razón desde el beneficio mutuo: dar una respuesta útil y no hacer perder tiempo ni esfuerzo a ninguna de las partes.
- La conversación con Tomás o Kike es una vía humana complementaria, no sustitutiva del formulario. Sirve para resolver dudas de encaje antes de reunir toda la documentación; una conversación no convierte por sí sola una oportunidad inmadura en proyecto evaluable.
- El cierre identifica a **Tomás Bensadón** y **Kike Sáenz**, ambos Gestores de Comunidades Energéticas, con sus fotografías y correos verificados. Tomás conserva además su teléfono publicado. Mientras no exista una agenda personal pública, `Solicitar una reunión` abre un correo preparado para acordarla; no debe enviarse este tráfico a la agenda genérica de asesores energéticos.

CTA principal: **Analizar el encaje de mi planta**. Abre el formulario Zoho específico dentro de la propia página, en un marco blanco centrado y alineado con la identidad de Comunidad Solar, y se mide con `operational_plant_study_open`.

Reglas de integración del formulario:

- El formulario conserva todos sus campos y su función de filtro; la mejora es únicamente de presentación y continuidad de navegación.
- Zoho se carga al pulsar uno de los CTA, no al entrar en la página, para evitar coste y conexiones externas innecesarias antes de que exista intención.
- Todos los CTA de plantas de `/comunidades-energeticas-operativas` abren el mismo marco integrado y hacen desplazamiento suave hasta él.
- El acceso desde `/rentabiliza-tu-activo` conduce directamente a esa integración mediante `#formulario-planta`.
- El marco identifica la finalidad del formulario, anticipa la documentación necesaria y conserva la política de privacidad.
- Debe existir siempre el enlace secundario **Abrir en una pestaña nueva** como salida de compatibilidad si un navegador, una extensión o la configuración de Zoho impide la inserción.
- La URL integrada añade `referrername=web-comunidades-energeticas-operativas` para distinguir este origen sin incorporar datos personales.

CTA complementario: **Solicitar una reunión**. Tomás se mide con `operational_tomas_meeting_request`; teléfono y correo usan `operational_tomas_phone_click` y `operational_tomas_email_click`. Kike se mide con `operational_kike_meeting_request` y `operational_kike_email_click`.

La URL histórica deja de estar clasificada como redirección y pasa a preservarse de forma nativa en el mapa de migración y en el sitemap.

### 5.14 Blog y prueba de comunidad

El Blog demuestra actividad, personas y trayectoria.

Incluye:

- comuneros;
- visitas a parques;
- encuentros e inauguraciones;
- hitos de proyectos;
- testimonios;
- vídeos;
- publicaciones sociales relevantes;
- archivo histórico.

Cada pieza conserva fecha, protagonista, ubicación cuando exista y fuente. FAQ, soporte, trámites, pruebas y contenido sin relación real con la comunidad quedan fuera.

### 5.15 Eventos y webinars

`/eventos` es la única puerta pública de Comunidad Solar para consultar
encuentros y webinars, aunque su inscripción o archivo se gestione en dos
plataformas distintas:

- **Zoho Backstage** gestiona visitas, jornadas y encuentros presenciales o
  híbridos.
- **Zoho TrainerCentral** gestiona webinars y sesiones online.

La página separa siempre **Próximos eventos** de **Eventos anteriores**. Si no
existe ninguna convocatoria pública confirmada, muestra un estado vacío y la
fecha de la última revisión; no rellena el espacio con un borrador, una prueba o
una cita cancelada.

Cada ficha necesita fecha, lugar o modalidad online, resumen, plataforma y URL
pública exacta. El clic continúa en la herramienta de Zoho correspondiente.
Solo pueden incorporarse convocatorias con inscripción pública abierta o
eventos cuya celebración esté comprobada. Quedan fuera los webinars privados
de socios, las reuniones internas y cualquier sesión cuyo estado o audiencia no
se pueda verificar.

La selección es deliberadamente editorial y vive en `app/events-data.ts`; no se
sincroniza automáticamente con todo el inventario de Zoho porque esa
automatización podría publicar pruebas, copias o contenido reservado. El enlace
del pie y el CTA de Eventos del Blog conducen primero a `/eventos`.

Mientras Marketing revisa y limpia los catálogos públicos de Backstage y
TrainerCentral, **Eventos queda retirado temporalmente de la navegación
principal**, tanto en escritorio como en móvil. La página y sus accesos
secundarios desde el Blog y el pie se conservan para no perder el trabajo ni sus
URLs. El enlace solo volverá al menú cuando se confirme que ambas plataformas
muestran exclusivamente convocatorias y archivos que deban ser públicos.

### 5.16 Soy comunero y contacto

`Soy comunero` conduce a:

- app para energía y documentación;
- portal identificado para consultas;
- teléfono y WhatsApp como alternativas.

`Contacto` separa:

- quien quiere informarse o contratar;
- quien ya es comunero y necesita servicio.

La web no promete identidad común, SSO o asociación automática con Helios hasta que esa integración exista.

### 5.17 Área privada de socios

`/socios` es la sala privada común para los socios fundadores autorizados. No se dirige a inversores de Crowdcube, no es una landing de inversión y no copia la web comercial.

La edición actual, con fecha de corte **30 de julio de 2026**, contiene:

- resumen ejecutivo y nota del fundador;
- resultados agrupados de gestión de 2025 con advertencia expresa de que no son cuentas consolidadas;
- agenda viva de hitos materiales, separando fechas confirmadas de ventanas objetivo;
- roadmap 2026–2027 resumido en tres horizontes;
- explicación de la relación entre rentabilidad operativa, inversión, coste financiero y caja;
- alianza operativa con Cubierta Solar y FIEE, sin presentarla como inversión societaria;
- subvenciones concedidas separadas del potencial sujeto a adquisiciones u opciones;
- motores de crecimiento y papel de Helios;
- incorporaciones de Pablo Bordas y Carlos Aguilera;
- índice protegido de materiales y criterio de la futura biblioteca societaria.

Reglas editoriales:

- cada cifra o hito lleva fecha de corte y estado de certeza;
- **confirmado**, **en curso** y **escenario de trabajo** nunca se mezclan;
- `programado` no significa `cerrado`;
- `concedido` no significa `cobrado`;
- `capacidad de financiación` no significa `dinero disponible`;
- `opción` no significa `activo adquirido`;
- `objetivo` no significa `previsión`;
- `lanzamiento comercial` no significa `proyecto contratado u operativo`;
- una fecha societaria solo se publica cuando existe convocatoria o confirmación suficiente;
- el portal común no incluye caja semanal, litigios, posiciones negociadoras, condiciones individuales, salarios, bonus, datos de clientes ni contratos sin revisar.

El acceso utiliza identidad individual mediante una cuenta ChatGPT cuyo correo debe coincidir con la lista autorizada en servidor. La contraseña la gestiona el proveedor de identidad y no se almacena en la web. Zoho CRM identifica 14 contactos con el tipo exacto `Comunero Socio Fundador`; la lista debe revisarse antes de cargarla en producción y no se usa una contraseña común.

La información estratégica vive en `app/socios/partner-data.ts`, importada solo por la ruta servidor. No debe moverse a `app/site.tsx`, porque ese archivo es cliente, ni a `public/`. Las actas, cuentas y demás documentos privados requerirán R2 o almacenamiento equivalente y una descarga que vuelva a comprobar la misma autorización. Nunca se enlazará directamente un PDF público ni se mostrará una biblioteca vacía.

---

## 6. Arquitectura de confianza

Cada prueba responde a una duda distinta.

### Reseñas

- Se muestran experiencias con la empresa o la atención.
- No prueban el ahorro de un producto concreto.
- Se utiliza `4,8/5` y `más de 400 reseñas` mientras el recuento exacto no esté automatizado.
- Autor, fecha y fuente deben ser verificables.

### Escala y trayectoria

- Más de 3.500 comuneros es una cifra corporativa que necesita propietario y revisión.
- Fundación en 2018.
- Proyectos, visitas e historias demuestran continuidad.

### Registro oficial

La formulación correcta es:

> **Comercializadora de electricidad inscrita en el censo de la CNMC · R2-883.**

El registro confirma la inscripción. No equivale a un aval del producto.

### Medios

- La home muestra una selección breve y enlazada de apariciones después del giro estratégico y del bloque de los tres mundos.
- Esa selección combina una aparición visual principal de Antena 3, dos piezas secundarias y un índice compacto con el archivo completo; no debe convertirse en una cuadrícula uniforme de capturas.
- La imagen principal procede del reportaje editorial de Antena 3 de agosto de 2023 y enlaza a su publicación oficial. El reel televisivo de la página de Autoconsumo Remoto sigue siendo una pieza independiente.
- Solo se utiliza imagen cuando procede de una aparición real y enlaza a su publicación original. Las piezas sin imagen verificada se presentan como fichas editoriales.
- Se presentan como archivo histórico fechado.
- Nunca como recomendación o garantía.
- Las piezas antiguas sobre Remoto pueden contener cifras de otra etapa.
- No se mezcla contenido patrocinado con cobertura editorial.

### Entidades legales

- **Comunidad Solar Power, S.L.** · CIF B88223144 · C/ Cólquide 17 · 28231 Las Rozas de Madrid.
- **Comercializadora Eléctrica Comunidad Solar, S.L.** · NIF B67571802 · CNMC R2-883.

---

## 7. Recorridos, CTAs e integraciones

| Necesidad | Destino vigente | Regla |
|---|---|---|
| Cobertura de Comunidad Energética | `https://calculadoraenergetica.comunidadsolar.es` | Nunca usar el enlace interno antiguo |
| Propuesta de Torrontera | `https://presupuesto-ar.comunidadsolar.es` | Tratarlo como propuesta de largo plazo |
| Estudio de batería | `https://calculadorabaterias.comunidadsolar.es/` | Mostrar primero compatibilidad y alcance |
| Megapark | Formulario de información | No permitir contratación separada |
| Megahome | Recorrido de contratación | Solo instalación propia o código |
| Aerotermia | Formulario de Coolfy | Identificar al partner |
| Mantenimiento | Email, teléfono y web de Solaico | Contrato directo con Solaico |
| App del comunero | Acceso web y tiendas oficiales | No replicar datos privados |
| Atención al Comunero | Portal identificado de ayuda | Separar de captación |
| Área de socios | `/socios` | Identidad individual y correo autorizado |

### Analítica mínima

Cada CTA principal debe tener un evento estable que permita distinguir:

- apertura de cobertura;
- propuesta de Remoto;
- estudio de batería;
- estudio fotovoltaico;
- contacto Coolfy;
- contacto Solaico;
- acceso a app;
- acceso a Atención;
- apertura de formulario;
- salida a una fuente externa.

Los nombres de evento se mantienen estables aunque cambie el texto visible.

`/socios` y `/guia-equipo` quedan excluidos de `page_view` y eventos de Google Analytics. La visita a un espacio privado no se envía a la analítica pública.

### Formularios

- Validación real en servidor o proveedor.
- Consentimiento y finalidad comprensibles.
- Sin campos de demo.
- Sin mensajes que prometan una acción automática inexistente.
- Errores y confirmaciones visibles y accesibles.
- Atribución de campaña conservada hasta CRM.

---

## 8. Datos y gobierno de la información

### Fuentes actuales dentro del proyecto

| Fuente | Contenido | Consumidores |
|---|---|---|
| `app/community-data.ts` | Comunidades, instalaciones, estados, hitos y mapa | General, fichas, relacionados y sitemap |
| `app/remote-project-data.ts` | Torrontera, Fuente Álamo y Ligüérzana | General Remoto, fichas y relacionados |
| `app/blog-data.ts` | Historias, categorías, fuentes y fechas | Blog, detalles y relacionados |
| `app/events-data.ts` | Agenda pública curada, plataformas, fechas y enlaces verificados | Eventos, archivo y salidas a Zoho |
| `app/trust-data.ts` | Reseñas, testimonios, medios, legales y CNMC | Home, confianza y pie |
| `app/legal-content.ts` | Copia literal, fecha de origen y huella de los cuatro documentos jurídicos | Privacidad, cookies, aviso legal y términos |
| `app/site.tsx` | Páginas, recorridos, CTAs y componentes | Todas las rutas de contenido |
| `app/legacy-routes.ts` | Redirecciones y servicios retirados | Compatibilidad y SEO |
| `app/guide-content.md` | Este manual | Página y descarga `.md` |

### Modelo mínimo de una Comunidad Energética

Una comunidad necesita, como mínimo:

- identificador estable y slug;
- nombre y municipio;
- provincia y región;
- imagen real y texto alternativo;
- modalidad o modalidades;
- radio de cobertura;
- estado técnico comprensible;
- estado de energía en factura;
- situación comercial y plazas;
- potencia y número de instalaciones cuando estén confirmados;
- hitos;
- siguiente paso;
- fecha de revisión;
- fuente responsable.

### Estados que no se deben mezclar

- Diseño o preparación.
- Obra.
- Conexión.
- Legalización.
- Reparto o activación.
- Energía en factura.
- Disponibilidad comercial.

Una misma instalación puede estar conectada y seguir sin energía en factura. Puede estar en funcionamiento y no tener plazas.

### Modelo mínimo de Remoto

- activo e instalación concreta;
- ubicación;
- tecnología;
- potencia;
- producción estimada;
- almacenamiento;
- estado técnico;
- disponibilidad comercial;
- duración;
- costes;
- tratamiento en factura;
- mantenimiento y seguro;
- cambio de comercializadora;
- cesión y herencia;
- fecha de revisión;
- fuente contractual.

### Evolución a CRM y Helios

El objetivo no es duplicar estos objetos en otro sistema. CRM y Helios deben convertirse en fuente operativa para:

- capacidad;
- plazas;
- hitos;
- participantes;
- contratos;
- coeficientes;
- facturación;
- leads;
- seguimiento.

La web seguirá necesitando una capa editorial para transformar datos técnicos en lenguaje de cliente.

### Responsables

| Tipo de dato | Propietario | Revisión |
|---|---|---|
| Estado e hitos | Operaciones | Responsable de proyecto |
| Capacidad y plazas | Operaciones y Comercial | Dirección Comercial |
| Precio y ahorro | Producto y Finanzas | Dirección y Legal |
| Contratos y claims | Legal y Producto | Dirección |
| Relato e imágenes | Marketing | Producto |
| Blog y testimonios | Marketing y Comunidad | Protagonista u Operaciones |
| Reseñas, medios y credenciales | Marketing y Legal | Dirección o fuente oficial |
| Integración y tracking | Tecnología | Producto y Marketing |
| Manual de equipo | Responsable del cambio | Responsable de publicación |

---

## 9. Sistema visual

### Marca

- El logotipo maestro de la web es `/comunidad-solar-logo.svg`.
- La misma cabecera corporativa y el mismo logotipo se utilizan en la home y en las páginas interiores.
- El hero experimental de inicio no se interpreta como un rebranding del resto de la web.
- Las imágenes se producen sin titulares, botones o logotipos incrustados.

### Paleta base

- Tinta: `#101b16`
- Fondo papel: `#f7f8f3`
- Verde principal: `#a8d96f`
- Verde profundo: `#163e31`
- Amarillo: `#ffd968`
- Azul: `#a9e4ee`
- Menta: `#79cfb7`
- Experimento de home: crema `#f8f4e9`, verde profundo `#032219` y amarillo dorado `#f8c734`

### Composición

- Inter y pila de sistema.
- Titulares grandes y directos.
- Mucho espacio en blanco.
- Tarjetas con bordes suaves y radios amplios.
- Jerarquía clara antes que ornamentación.
- Responsive real, no una versión de escritorio encogida.

### Imágenes

- Personas, instalaciones y lugares reales cuando aportan prueba.
- Diagramas para explicar flujos.
- Iconos para acciones y estados.
- Texto alternativo informativo.
- Nada de caras generadas para representar al equipo.
- Nada de imágenes genéricas cuando existe una fotografía propia mejor.
- Las tarjetas de comunidades deben tener imágenes diferentes y vinculadas a su cubierta o municipio.
- Los recursos recuperados de herramientas históricas se descargan, optimizan y sirven desde la web; no se enlazan desde proveedores temporales.
- Una escena conceptual o generada no se presenta como un proyecto, cliente, comunero o miembro real del equipo.
- El hero de la opción 1 preserva el detalle territorial de la mitad derecha y concentra el velo verde en la zona izquierda de lectura.

### Vídeo

- Piezas actuales para explicar la propuesta vigente.
- Archivo histórico claramente fechado.
- Miniatura, título y contenido deben corresponder.
- Un vídeo antiguo no puede validar cifras actuales.

---

## 10. Arquitectura técnica

### Base

- Next compatible mediante Vinext.
- React y TypeScript.
- Vite para compilación.
- Worker de Cloudflare como salida.
- CSS global con sistema de tokens.
- Datos editoriales tipados en módulos compartidos.

### Rutas

- `app/page.tsx`: portada.
- `app/[slug]/page.tsx`: páginas base.
- `app/comunidades-energeticas/[community]/page.tsx`: fichas de comunidades.
- `app/autoconsumo-remoto/[project]/page.tsx`: activos Remoto.
- `app/blog/[post]/page.tsx`: historias.
- `app/socios/page.tsx`: área privada de socios, dinámica y autorizada en servidor.
- `app/guia-equipo/page.tsx`: manual interno protegido.
- rutas explícitas para servicios retirados.
- ruta explícita y protegida para descargar el manual.

### Fuente única del manual

`app/guide-content.md` se importa como texto únicamente en el grafo de servidor.

- `app/team-guide-page.tsx` es un componente servidor y lo convierte en la página de lectura.
- `app/guia-equipo-nueva-web-comunidad-solar.md/route.ts` autentica, autoriza y devuelve el mismo contenido como archivo privado.
- `app/guide-runtime.ts` inserta recuentos derivados de los datos reales.
- No debe añadirse una segunda copia en `public/`.
- El manual no se importa desde `app/site.tsx` ni desde ningún componente cliente.

### Compilación y controles

El proceso:

1. verifica que los cambios relevantes incluyen actualización del manual;
2. compila la web;
3. valida el artefacto;
4. ejecuta comprobaciones sobre HTML y rutas reales;
5. solo después permite guardar y publicar una versión.

### Seguridad

- Sin secretos en navegador, código o URLs.
- Validación de servidor en formularios propios.
- Limitación de abuso e idempotencia donde exista escritura.
- Dependencias y enlaces externos controlados.
- Nada de autenticación de ChatGPT para comuneros.
- La autenticación de socios y equipo utiliza el flujo de identidad de ChatGPT; la autorización se decide además contra listas de correo de servidor.
- `SOCIOS_ALLOWED_EMAILS` y `TEAM_ALLOWED_EMAILS` se gestionan como variables sensibles del alojamiento y fallan cerradas cuando están vacías.
- Las áreas privadas y sus descargas usan `private, no-store`, `noindex, nofollow, noarchive`, `nosniff` y política de referente restringida.
- Un usuario identificado pero no autorizado no recibe contenido estratégico.
- El área de socios general y el manual del equipo conservan permisos separados.

### Privacidad y consentimiento

- Gestor de consentimiento activo y accesible desde **Configurar cookies** en
  todas las páginas.
- Google Analytics no se carga antes de aceptar analítica.
- Aceptar y rechazar analítica están disponibles en la primera capa con la
  misma jerarquía visual.
- La preferencia puede consultarse, modificarse o retirarse desde el mismo
  gestor.
- `/politica-privacidad`, `/cookies`, `/aviso-legal` y
  `/terminos-y-condiciones` son páginas nativas con la URL histórica.
- El cuerpo de esos cuatro documentos se importó literalmente desde la web
  vigente. Diseño y marcado pueden evolucionar; sus palabras solo cambian con
  validación jurídica expresa.
- Una huella textual fija por documento hace fallar las comprobaciones si se
  altera, omite o añade contenido.
- Las páginas legales conservan `noindex`; no se añaden al sitemap.
- Formularios con finalidad y tratamiento claros.
- No recoger datos que no sean necesarios.
- Las rutas privadas quedan fuera de Google Analytics incluso cuando el visitante haya aceptado analítica en la web pública.

### SEO

- Metadatos por ruta.
- Canonical correcto.
- Sitemap con páginas públicas.
- Redirecciones para URLs antiguas útiles.
- `410` y `noindex` para servicios retirados.
- El área de socios y la guía de equipo no entran en el sitemap, se bloquean en `robots.txt` y usan cabeceras `noindex`.

### Accesibilidad

- Salto al contenido.
- Navegación por teclado.
- Foco visible.
- Menús con estado accesible.
- Encabezados jerárquicos.
- Contraste suficiente.
- Formularios con etiqueta y error.
- Tablas desplazables en móvil.
- Textos alternativos útiles.

---

## 11. Flujo de trabajo para cualquier cambio

### Antes de tocar la web

1. Identificar qué persona y qué decisión afecta.
2. Confirmar la fuente del dato o de la condición.
3. Revisar páginas relacionadas y no solo la URL solicitada.
4. Comparar con contratos cuando el cambio afecta a producto.
5. Abrir enlaces de la web anterior si se está modernizando contenido.

### Durante la implementación

1. Actualizar la fuente compartida, no una copia aislada.
2. Escribir en lenguaje de cliente.
3. Mantener móvil, teclado y accesibilidad.
4. Conservar eventos de analítica.
5. Actualizar este manual y su registro de cambios.
6. Añadir o adaptar una comprobación automática.
7. Si hay información privada, comprobar anónimo, cuenta no autorizada y cuenta autorizada.

### Antes de publicar

1. Leer la página completa como cliente.
2. Revisar visualmente escritorio y móvil.
3. Comprobar todos los CTA.
4. Validar que no aparece texto interno o de demo.
5. Confirmar fechas, precios, plazos y responsables.
6. Ejecutar compilación y pruebas.
7. Verificar con una cuenta autorizada que `/guia-equipo` y el `.md` reflejan el cambio.
8. Publicar y comprobar el estado final del despliegue.

---

## 12. Criterios de aceptación

Un cambio está terminado cuando:

- responde a una necesidad concreta;
- utiliza la fuente y el responsable correctos;
- no contradice contrato, propuesta o recorrido;
- mapa, tarjeta, ficha y cobertura cuentan la misma verdad;
- compra y alquiler siguen diferenciados;
- Megapark y Megahome conservan sus vías de acceso;
- Remoto no promete factura cero ni retorno rápido;
- los estados se expresan para clientes;
- existen carga, error, vacío y siguiente paso cuando proceda;
- los formularios y enlaces funcionan;
- consentimiento y analítica se conservan;
- las rutas privadas fallan cerradas, no se cachean ni envían analítica;
- ningún contenido estratégico aparece en HTML anónimo, `public/` o bundles cliente;
- teclado, móvil, foco, contraste y textos alternativos se revisan;
- imágenes, redirecciones, SEO y rendimiento pasan control;
- un cambio visual localizado mantiene logo, paleta, tipografía y componentes compartidos salvo una decisión explícita de rebranding;
- no aparecen `demo`, `prototipo`, `no publicado`, `inventario`, `la ficha` o URLs internas;
- el manual contiene la decisión y el registro de cambios;
- la página de guía y el `.md` muestran la misma versión.

---

## 13. Pendientes priorizados

### P0. Antes de sustituir el dominio corporativo

1. Confirmar todas las condiciones contractuales y económicas públicas.
2. Resolver las incoherencias internas detectadas en contratos de Torrontera.
3. Validar y mantener actualizados financiación de batería, cuotas y ofertas.
4. Completar matriz de redirecciones del dominio antiguo.
5. Confirmar responsables y cadencia de reseñas, comuneros y credenciales.
6. Revisión manual de todas las rutas con criterio de cliente final.

### P1. Operación conectada

1. Llevar capacidad, plazas y estados desde CRM y Helios.
2. CMS editorial con borrador, revisión, fuente, permisos e historial.
3. Identidad común o integración documentada entre app, Atención y Helios.
4. Conciliación de leads, atribución y analítica de principio a fin.
5. Alertas por dato caducado o estado incoherente.
6. Casos reales completos por producto.
7. Fuente societaria verificada para altas y revocaciones del área de socios.
8. D1 para roles y auditoría si el volumen de socios supera la gestión segura por lista.
9. R2 o repositorio equivalente antes de ofrecer documentos privados descargables.

### P2. Evolución

1. Personalización por dirección y perfil.
2. Mercado secundario cuando exista definición comercial y jurídica.
3. Contenido regional y SEO local.
4. Experimentos de conversión medidos.
5. Automatización editorial con aprobación humana.

---

## 14. Registro de cambios

### 31 de julio de 2026

- Protege con comprobaciones automáticas la formulación de beneficio local y la descripción social de Manganáfer.

- Reformula el ámbito de Manganáfer como beneficio local y alinea la vista previa social con la frase fuerza del hero.

- Amplía el ámbito de Manganáfer de 500 m a 1 km.

- Asegura la validación CUPS y el cálculo de Manganáfer sin guardar datos ni inventar parámetros comerciales.

- Finaliza la integración segura de la calculadora CUPS de Manganáfer y sus parámetros de activación.

- Integra el flujo seguro de cálculo de Manganáfer con CUPS, validación de 500 m y el backend de quoting actual.

- Aclara el ámbito máximo de 500 m de Manganáfer, incorpora un mapa local orientativo y prepara la activación de su quoting en la calculadora existente.

- Aclarado que Manganáfer se dirige exclusivamente a suministros situados a un máximo de 500 m, con un mapa local orientativo y confirmación final mediante CUPS.

- Integrado el flujo seguro CUPS → validación de 500 m → quoting existente, sin guardar el CUPS ni exponer credenciales; la calculadora solo aparece cuando todos los parámetros comerciales están validados y configurados.

- Asegurado el acceso diferido a D1 para que la captación de Manganáfer funcione en Cloudflare sin romper la validación del artefacto.

- Añadida la campaña territorial de Manganáfer con mensaje centrado en el beneficio local, registro de interés persistente, área privada de seguimiento y sin publicar todavía la procedencia o arquitectura técnica de la energía.

### 30 de julio de 2026

- Aclara el carácter previsto del cierre de Chiva y alinea el resumen del roadmap con sus tres horizontes.

- Reformula el área privada para socios fundadores con resultados, agenda, roadmap, equipo y biblioteca protegida, y retira su enlace público.

- Reformulada `/socios` como área exclusiva de socios fundadores, con resumen ejecutivo, resultados agrupados de 2025, agenda de hitos, roadmap 2026–2027, subvenciones por nivel de certeza, motores de crecimiento y las incorporaciones de Pablo Bordas y Carlos Aguilera.
- Eliminados los textos de desarrollo, estados desactualizados y repeticiones de la primera maqueta.
- Retirado el enlace público «Acceso socios» del pie; la ruta solo se comunica individualmente.
- Preparado el criterio de biblioteca societaria: actas y documentos aprobados, siempre con almacenamiento y descarga protegidos.
- Actualizado el acceso para explicar expresamente la identificación con ChatGPT y la coincidencia de correo con la lista autorizada.

### 29 de julio de 2026

- Rediseñado el hero de /nosotros alrededor de la misión y #PorElPlaneta, con la cabecera corporativa compartida, el fotograma oficial de Damián Villa y acceso al vídeo 'Hay decisiones que iluminan el futuro'; la independencia queda como consecuencia de la misión.

- Actualizado el recuento protegido del manual a 64 rutas tras incorporar las fichas de Ontinyent y Escurial.

- Añadidas las fichas y cards de Ontinyent–Dream Home Textil y Escurial–Mármoles Jiménez, con instalaciones construidas, participación en lista de espera, imágenes propias, datos técnicos y redirección histórica de Ontinyent.

- Protege automáticamente que las diez comunidades extremeñas utilicen archivos de imagen locales, descriptivos y distintos entre sí.

- Sustituye la imagen genérica repetida de las diez comunidades extremeñas por cuatro simulaciones de cubiertas del mapa histórico y seis fotografías reales representativas de cada localidad, optimizadas y con textos alternativos específicos.

- Se elimina el párrafo introductorio redundante en los accesos generales a la calculadora de cobertura para compactar el bloque, manteniendo el contexto específico en las fichas locales.

- Protege con una comprobación automática el orden cobertura → giro estratégico → tres mundos → medios de la portada.

- Reordena la home con cobertura → giro estratégico → tres mundos → medios; sustituye las tres modalidades anteriores por Comunidad Energética, Autoconsumo Remoto e instalación en tu tejado, manteniendo el buscador como puerta principal capaz de ofrecer alternativas cuando no existe cobertura.

- Reordena la home con cobertura → giro estratégico → tres mundos → medios; sustituye las tres modalidades anteriores por Comunidad Energética, Autoconsumo Remoto e instalación en tu tejado, manteniendo el buscador como puerta principal capaz de ofrecer alternativas cuando no existe cobertura.

- Corrige la asociación accesible del mensaje fuerza al titular de Autoconsumo Remoto.

- Mantiene el mensaje fuerza completo del hero como nombre accesible del titular.

- Integra el mensaje y el vídeo de Antena 3 en una única composición orgánica del hero de Autoconsumo Remoto, con ruta luminosa, solapamientos y movimiento accesible.

- Alineada la validación del nuevo mensaje de Autoconsumo Remoto con el enfoque de tus paneles a distancia.

- Reformulado Autoconsumo Remoto alrededor de tus paneles a distancia, manteniendo la precisión contractual y Antena 3 como prueba principal del hero.

- Reubica la red luminosa del hero de Comunidades Energéticas en el borde del colegio orientado al pueblo, evita que las líneas atraviesen la cubierta e incorpora flujo y pulsación respetando movimiento reducido.

### 28 de julio de 2026

- Renueva el hero de Comunidades Energéticas con una promesa explícita de ahorro, una cubierta escolar y una red local de energía.

- Mantiene el mensaje de claridad y añade el alcance global de 320 proyectos y 96 MW antes de las comunidades publicadas.

- Simplifica las métricas globales y su nota de transparencia.

- Afina el lenguaje de alcance total, red especial y comunidades publicadas.

- Reordenada la sección pública de comunidades como mapa → alcance total → red especial Extremeña → fichas individuales; el bloque global muestra más de 320 proyectos y más de 96 MW en negociación o desarrollo activo, dejando claro que no todos están cerrados ni disponibles.

- Sustituida la portada televisiva genérica por una captura verificada del reportaje editorial de Antena 3 de agosto de 2023 y enlazada a la pieza oficial.

- Reorganizado el bloque de medios de la home con una aparición televisiva real destacada, dos publicaciones secundarias y el archivo completo, manteniendo separados el reel y la cobertura editorial.

- Protegemos con una comprobación automática que Eventos no reaparezca en los menús de escritorio o móvil durante la revisión.

- Retiramos temporalmente Eventos del menú principal mientras se depuran Backstage y TrainerCentral; la página y sus accesos secundarios se conservan.

- Ajustamos la comprobación renderizada de la fecha de revisión de la agenda.

- Ajustamos la agenda pública a cuatro eventos celebrados con estado y audiencia inequívocos.

- Integramos una agenda pública única de eventos y webinars con fuentes verificadas de Zoho Backstage y TrainerCentral.

- Adelantado el modelo 80/20 de plantas operativas, humanizado el proceso e incorporado Kike Sáenz junto a Tomás en el cierre.

- Adelantado el modelo 80/20 de plantas operativas, humanizado el proceso e incorporado Kike Sáenz junto a Tomás en el cierre.

- Aplica las cabeceras privadas también a la raíz exacta del área de socios.

- Ajusta la validación de caché privada a la normalización segura del entorno.

- Asegura la compatibilidad de la autorización privada con el entorno de despliegue y las pruebas.

- Documenta el área de socios, el acceso individual y la protección completa del manual.

- Crea el área privada de socios y protege el manual interno con autorización individual.

- Creada `/socios` como sala privada de información para accionistas fundadores e inversores de Crowdcube, con pulso ejecutivo, estrategia, proyectos, crecimiento, financiación y archivo de actualizaciones.
- Separados en toda la edición los estados **confirmado**, **en curso** y **escenario de trabajo**, con fecha de corte y advertencias contra confundir concesión, cobro, opción, capacidad y objetivo.
- Implantado acceso individual mediante identidad ChatGPT y autorización de correo en servidor; el sistema falla cerrado y Paco es el único usuario inicial hasta validar la lista societaria.
- Añadido un único acceso discreto a socios en el pie, sin ocupar la navegación principal.
- Excluidas `/socios` y `/guia-equipo` de Google Analytics, sitemap y caché pública.
- Corregida la exposición histórica del manual: `/guia-equipo` y la descarga `.md` dejan de ser públicas, se autorizan en servidor y el Markdown ya no entra en un bundle cliente.
- Añadidas comprobaciones para visitante anónimo, cuenta no autorizada, socio autorizado, manual protegido y descarga directa.

### 27 de julio de 2026

- Ajusta la comprobación del gestor de cookies para validar sus dos opciones aunque el JSX tenga saltos de línea.

- Alinea el gestor de cookies con las rutas legales nativas y ofrece aceptar o rechazar analítica con igual jerarquía visual.

- Integra como páginas nativas Privacidad, Cookies, Aviso legal y Términos conservando literalmente sus textos y URLs históricas, protege cada documento con una huella textual y mantiene Configurar cookies como gestor funcional accesible desde toda la web.

- La banda de confianza de plantas operativas añade 34 píxeles de aire superior solo cuando sus cuatro tarjetas se muestran en una fila de escritorio; tablet, móvil y las demás páginas conservan su composición.

- Rediseña el hero de plantas operativas como Red de valor, con planta, nodo Helios, conexiones a demanda y tres mensajes inferiores, conservando intacta la cabecera corporativa compartida.

- En móvil, el hero España conectada comienza inmediatamente bajo la cabecera, sin el relleno superior genérico; escritorio y los demás heroes no cambian.

- Equilibra el aire superior e inferior de la banda de confianza de la home sin afectar a sus variantes compactas.

- Incorpora en la home la franja superior corporativa con los dos mensajes de las páginas interiores, sin modificar el menú, el hero España conectada ni los módulos posteriores.

- Ajusta el último ramal derecho para que termine sobre un tejado visible.

- Amplía la red luminosa del hero hasta nueve viviendas y elimina los finales que no conectaban con casas.

- Actualiza la comprobación automática para proteger la cabecera corporativa y mantener intacto el hero España conectada.

- Restaura en la home la cabecera corporativa compartida sin modificar el hero España conectada ni los módulos posteriores.

- La conexión desde la batería bordea el parque solar por ambos lados y los dos nodos más próximos al centro reparten la energía mediante seis derivaciones cortas hacia viviendas.

- Alinea los tres ramales del hero con el cruce y las calles visibles del pueblo.

- Ramifica la energía del hero hacia varias viviendas y convierte la tarjeta específica en acceso a toda la red de comunidades.

- Ramificada la ruta de energía del hero por tres calles hacia varias zonas del pueblo y sustituida la tarjeta fija de Villalbilla por un acceso corporativo a toda la red de comunidades.

- Crea la versión B del hero de la home con la opción 1 España conectada y mantiene intactos los módulos posteriores.

- Creada la versión B de la home con la opción 1 «España conectada»: cabecera horizontal, paisaje territorial, ruta energética, mapa real conectado a Villalbilla y tres mensajes fuerza en una línea; todos los módulos desde `TrustBand` permanecen intactos y la opción 3 continúa disponible en el historial para revertir.

- Monta la opción 3 original en la cabecera y el hero de la home sin alterar los módulos posteriores.

- Montada la opción 3 original como experimento reversible en el primer pantallazo de la home: cabecera crema, logo radial, hero a sangre, escena luminosa, arcos de energía y franja icónica. Todos los módulos posteriores permanecen intactos.

- Asegura los tres mensajes fuerza del hero y su comprobación automática.

- Mantiene un destino accesible para los CTA antes de cargar Zoho y revela el marco solo cuando existe intención.

- Integrado el formulario detallado de plantas operativas dentro de un marco centrado de Comunidad Solar, con carga bajo demanda, seguimiento de origen y enlace externo de respaldo; los CTA ya no expulsan al usuario a la página completa de Zoho.

- Añadida una vía humana complementaria al formulario de plantas: Tomás Bensadón aparece con su fotografía y contacto verificados para solicitar una reunión sin rebajar el filtro documental.

- Corregido el criterio de captación de plantas operativas: el formulario detallado se mantiene como filtro deliberado de madurez y la página explica la documentación necesaria para no hacer perder tiempo a ninguna de las partes.

- Ajustada la comprobación del manual al nuevo total de 56 rutas.

- Publicada la página específica para plantas operativas y enlazada desde los recorridos de propietarios.

- Fijada como portada previa al clic del reel televisivo la aparición de Antena 3 con la presentadora y la marca Comunidad Solar.

- Añadida una comprobación renderizada que garantiza que el reel televisivo aparece en el hero de Autoconsumo Remoto, antes de los datos del producto y sin duplicarse en la videoteca.

- Sustituido el visual estático del hero de Autoconsumo Remoto por el reel real de apariciones televisivas de Comunidad Solar para aportar prueba externa desde el primer pantallazo, con carga al pulsar y sin duplicarlo en la videoteca.

- Añadido en la home un bloque alto de Comunidad Solar en los medios, situado tras la comprobación de cobertura, con seis apariciones editoriales verificadas y enlaces directos; el archivo histórico conserva fechas y evita trasladar cifras antiguas a la oferta actual.

- Eliminada la antigua página de guía que había quedado oculta para evitar una segunda copia obsoleta.

- Mejorada la legibilidad visual del manual con listas explícitas y separación de secciones más limpia.

- Ajustada la comprobación renderizada del contador dinámico de rutas de la guía.

- Restaurada la guía viva desde una fuente única, actualizado su contenido y añadido un bloqueo automático contra la desincronización.

- Restaurada la guía para el equipo en el pie de todas las páginas.
- Recuperada la descarga `.md`.
- Convertidos página y archivo en dos vistas de una única fuente.
- Añadida regla automática que bloquea la publicación si una modificación relevante no actualiza el manual.
- Actualizados recuentos desde las fuentes reales de comunidades, Remoto y Blog.
- Sustituida la URL de cobertura por `calculadoraenergetica.comunidadsolar.es`.
- Limpiado lenguaje interno de las fichas de Comunidades Energéticas.
- Documentadas las decisiones recientes de Remoto, comercializadora, factura, servicios del hogar y retirada del cargador.

### 26 de julio de 2026

- Autoconsumo Remoto reordenado para explicar producto, Torrontera, largo plazo, factura, seguridad y pruebas.
- Mensajes de Torrontera contrastados con contratos de cliente.
- Aclarada la compra anticipada de energía, una instalación por contrato, coincidencia horaria, cuotas, monedero, cambio de comercializadora, cesión y herencia.
- Fuente Álamo y Ligüérzana convertidos en prueba histórica, no oferta vigente.
- Ligüérzana reescrita como central hidroeléctrica real de 500 kW.
- Comercializadora corregida: Megapark no se contrata; Megahome mantiene vías de acceso limitadas.
- Sustituida la calculadora compleja por una factura visual estática.
- Cargador eléctrico eliminado de catálogo y acceso público.
- Baterías ampliadas a hogares con o sin placas.
- Fotovoltaica incorpora la batería desde el diseño.
- Aerotermia identifica a Coolfy como partner.

### 25 de julio de 2026

- Construida la arquitectura inicial de la nueva web.
- Creadas fuentes comunes para comunidades, Remoto, Blog y confianza.
- Añadidos mapa, fichas, historias, asesores, Atención y rutas de servicio.
- Creado el primer manual integral de estrategia e implementación.

---

## 15. Decisiones que no deben regresar

- No volver a presentar la web como prototipo o demo.
- No ocultar campos internos detrás de una falsa transparencia.
- No crear calculadoras que no respondan a una necesidad clara.
- No presentar Megapark como una tarifa contratable.
- No mezclar una factura visual con un simulador.
- No vender Remoto como retorno rápido.
- Se puede hablar comercialmente de “tus paneles” como forma de visualizar la
  asignación, pero nunca afirmar que el cliente adquiere la propiedad física de
  los módulos o de la planta.
- No sugerir que un contrato vincula simultáneamente a las dos plantas.
- No presentar Fuente Álamo o Ligüérzana como plazas disponibles.
- No convertir medios o reseñas en garantías.
- No atribuir a Comunidad Solar servicios contratados directamente con Solaico o Coolfy.
- No recuperar el cargador eléctrico sin una decisión expresa de producto.
- No usar enlaces internos de asesores en páginas públicas.
- No eliminar esta guía para limpiar marcadores de prototipo: la guía es documentación viva, no contenido de demo.
