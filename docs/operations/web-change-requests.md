# Solicitar cambios en la web

Esta guía permite pedir un cambio en Comunidad Solar sin necesidad de conocer
Astro, Git ni Cloudflare. Sirve para texto, imágenes, páginas nuevas,
formularios, cambios de navegación, correcciones y mejoras funcionales.

El canal oficial es una [solicitud de cambio web en GitHub](https://github.com/vbenhur-cs/webComunidadSolar/issues/new/choose). Si la persona solicitante no tiene acceso al
repositorio, el responsable web debe abrir la solicitud en su nombre sin alterar
la información aprobada.

Una solicitud no publica nada por sí sola. Cada cambio pasa por revisión,
pruebas, una URL de preview y la aprobación correspondiente antes de una
entrega.

## Resumen del proceso

```text
Solicitud completa → revisión inicial → desarrollo en rama → CI → preview
→ aprobación de contenido → publicación controlada → confirmación
```

No se compromete una fecha de publicación hasta completar la revisión inicial:
la prioridad depende del impacto para clientes, requisitos legales, alcance y
evidencias disponibles.

## Paso a paso para quien solicita el cambio

### 1. Comprueba si ya existe una solicitud

Busca primero en las incidencias abiertas del repositorio y revisa la página
actual. Si el cambio ya está solicitado, añade la información nueva a esa
solicitud en lugar de abrir otra.

Los incidentes que impidan contratar, expongan información, muestren un dato
legalmente incorrecto o rompan una página pública deben marcarse como
**Crítico** e incluir una captura o enlace reproducible. No se corrigen
directamente en producción desde un ordenador personal.

### 2. Reúne la información antes de abrirla

La solicitud debe explicar el resultado que se busca, no solo una solución
propuesta. Incluye siempre:

- **Objetivo y motivo:** qué debe conseguir el cambio y para quién.
- **Página afectada:** URL actual y, si se crea una página, URL deseada.
- **Cambio exacto:** texto actual y texto nuevo, o una descripción inequívoca
  de lo que debe ocurrir.
- **Fuente verificable:** enlace, documento aprobado o persona responsable que
  confirma cada dato importante.
- **Criterio de aceptación:** cómo se sabrá que el cambio está correcto.
- **Persona que aprueba:** quien puede validar contenido, negocio o legal.
- **Fecha relevante:** solo cuando haya una campaña, evento o obligación real;
  explica qué ocurre si no se publica a tiempo.

Para imágenes, vídeos, logos o documentos, facilita el archivo final o un
enlace estable a la versión aprobada, su autor/origen, permiso de uso, texto
alternativo y pie o crédito si corresponde. No sirve una captura borrosa ni un
enlace temporal que pueda cambiar.

### 3. Añade la información específica del tipo de cambio

| Tipo de solicitud | Información adicional necesaria |
| --- | --- |
| Texto, titular o CTA | Texto literal, tono esperado, fuente de cifras y página concreta. |
| Imagen, vídeo o logo | Archivo o enlace estable, derechos de uso, autoría, texto alternativo y crédito. |
| Página nueva o campaña | Objetivo, público, URL propuesta, estructura, contenido aprobado, CTA, SEO, fecha de retirada y responsable. |
| Comunidad, proyecto, hito o cifra | Municipio, fecha de corte, estado (`confirmado`, `en curso` o `escenario`), fuente y responsable que lo confirma. |
| Formulario o captación | Finalidad, campos mínimos, destinatario, conservación, consentimiento, mensajes y responsable de los datos. |
| Cambio legal, precio, condiciones o promesa comercial | Texto aprobado por Legal/Negocio, fecha de vigencia, fuente contractual y persona que autoriza. |
| URL, navegación o SEO | URL actual y destino, motivo, enlaces internos afectados, título, descripción y si necesita redirección. |
| Calculadora o integración externa | URL externa, propietario, finalidad y comportamiento esperado. La calculadora se trata como dominio externo: no se solicitan ni publican sus credenciales en este repositorio. |
| Error técnico | Pasos para reproducirlo, URL, dispositivo/navegador, resultado esperado, resultado actual y captura si aporta evidencia. |

Si falta una fuente, una aprobación o el contenido definitivo, indícalo como
pendiente. El equipo no inventará cifras, condiciones, imágenes ni texto legal
para desbloquear una entrega.

### 4. Abre la solicitud con el formulario

En GitHub, selecciona **New issue** y elige **Solicitud de cambio web**. El
formulario pide la información mínima y deja constancia del responsable de
aprobación.

No incluyas nunca en una incidencia, comentario, captura o adjunto:

- contraseñas, tokens, claves API o credenciales de Cloudflare, Raiola, Zoho o
  cualquier proveedor;
- datos personales de clientes, facturas, CUPS, teléfonos, correos o contratos;
- enlaces internos que den acceso no autorizado;
- información confidencial que no esté autorizada para ser pública.

Entrega ejemplos anonimizados cuando sean necesarios para explicar un caso. Si
hay datos personales o una incidencia de seguridad, contacta primero con el
responsable correspondiente por el canal interno aprobado.

### 5. Responde a la revisión inicial

El responsable web clasificará la solicitud y puede pedir una aclaración. Una
solicitud queda lista para desarrollo cuando dispone de objetivo, alcance,
fuente, aprobador y criterios de aceptación verificables.

Las prioridades se aplican así:

| Prioridad | Cuándo usarla |
| --- | --- |
| Crítico | Riesgo de seguridad o privacidad, incumplimiento legal, información gravemente incorrecta o bloqueo real para clientes. |
| Alta | Campaña con fecha confirmada, página importante rota o impacto comercial significativo. |
| Normal | Mejora, contenido o corrección sin impacto inmediato. |
| Baja | Idea exploratoria, mejora futura o trabajo sin fecha ni fuente definitiva. |

La prioridad no sustituye la aprobación ni las pruebas. Un cambio crítico se
acelera, pero sigue dejando trazabilidad y revisión proporcional al riesgo.

### 6. Revisa el preview cuando se te solicite

CI valida el cambio, pero no crea una URL de preview automáticamente. Cuando
el responsable prepare la versión de revisión, compartirá su URL. La persona
solicitante y el aprobador deben revisar, como mínimo:

- el texto, cifras, fechas, enlaces y CTA;
- imágenes, créditos y textos alternativos;
- versión móvil y escritorio cuando afecte al diseño o navegación;
- formularios, mensajes y consentimiento cuando aplique;
- URL, título y descripción cuando afecte a SEO;
- que no se haya incluido información no pública.

Registra la aprobación o las correcciones en la misma solicitud. Un comentario
como «aprobado para publicar» debe identificar a la persona autorizada y la
versión de preview revisada.

### 7. Recibe la confirmación de entrega

La publicación la realiza únicamente la persona responsable de release mediante
el flujo protegido. La solicitud se cierra cuando incluye:

- el enlace de la entrega o la versión publicada;
- las pruebas aplicadas y el resultado de CI;
- cualquier redirección, cambio SEO o limitación conocida;
- una referencia a la aprobación de contenido.

Si el cambio requiere producción, se seguirá el [runbook de pruebas y
producción](production-release-runbook.md). Mientras el CD protegido no esté
habilitado, una solicitud aprobada no autoriza un despliegue manual ni cambios
en DNS, Raiola o el dominio principal.

## Estados de una solicitud

| Estado | Significado | Siguiente responsable |
| --- | --- | --- |
| Nueva | Se ha recibido, pero aún no se ha comprobado la información. | Responsable web |
| Pendiente de información | Faltan fuente, contenido, aprobación o criterio de aceptación. | Solicitante |
| En análisis | Se estima alcance, riesgo, SEO, privacidad y dependencia externa. | Responsable web / especialista |
| Aprobada para desarrollo | Alcance y aprobador definidos. | Equipo de desarrollo |
| En desarrollo | Existe una rama y una PR asociada. | Equipo de desarrollo |
| En revisión de preview | CI ha validado el cambio y existe una versión de revisión preparada. | Solicitante / aprobador |
| Aprobada para publicación | Preview aceptada y requisitos de release completos. | Responsable de release |
| Publicada | Se ha confirmado la entrega. | Responsable de release |
| Cerrada sin cambio | No procede, está duplicada o no se recibió la información necesaria. | Responsable web |

## Reglas que protegen la web y a sus usuarios

- Cada cifra, estado o afirmación comercial debe tener fuente y fecha de corte.
  No se mezclan datos confirmados, trabajos en curso y escenarios.
- Los cambios legales, de privacidad, cookies, precios, financiación o
  condiciones necesitan validación expresa del área responsable antes de
  publicarse.
- No se cambia una URL pública ni se retira una página sin revisar enlaces,
  sitemap, redirecciones y SEO.
- Las imágenes necesitan permiso de uso y alternativa accesible; no se reutiliza
  una imagen encontrada en internet sin autorización.
- Los formularios solo piden datos necesarios y no se conectan a un proveedor
  externo sin definir finalidad, consentimiento y responsable.
- Las pruebas y el preview no sustituyen la aprobación editorial, legal o de
  negocio.
- Nadie comparte credenciales ni solicita acceso a infraestructura dentro de un
  ticket de contenido.

## Qué recibe el equipo técnico

El equipo técnico convierte la solicitud aprobada en una rama y una Pull
Request. La automatización comprueba formato, tipos, contratos, enlaces,
imágenes, navegación, formularios, build independiente y la configuración de
Cloudflare sin publicar. El detalle técnico de esas comprobaciones está en el
[runbook de pruebas y producción](production-release-runbook.md).

La guía de [ingestión de páginas](ingestion.md) se usa solo cuando se aporta una
página o una solicitud que debe pasar por sus dos aprobaciones formales. Quien
solicita un cambio cotidiano no necesita ejecutar esa CLI.
