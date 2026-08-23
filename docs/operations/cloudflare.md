# Operación Cloudflare

El `wrangler.jsonc` del repositorio usa deliberadamente un identificador D1
local. No es un perfil publicable. Una publicación futura debe partir de un
archivo de operador externo, con un `database_id` de preview o producción, y
validarlo antes de usarlo:

```bash
CLOUDFLARE_CONFIG_PATH=/ruta/segura/perfil.jsonc \
CLOUDFLARE_ENV=preview \
npm run preview:cloudflare
```

`preview:cloudflare` valida el nombre, `main`, assets, compatibilidad de
Workers, el único binding `DB`, su directorio de migraciones, UUID D1 y
`SITE_INDEXABLE`. Las rutas se interpretan contra la raíz explícita del
proyecto y se rebajan de forma segura para la copia en artifacts. Rechaza
secretos literales, rutas inseguras y symlinks. No modifica el perfil del
operador: escribe sólo una copia canónica saneada y sin secretos en
`.artifacts/config/`. Su SHA-256 e indexabilidad se imprimen como metadatos de
operación; no se imprimen valores de bindings ni secretos.

Si se selecciona `CLOUDFLARE_ENV`, la copia conserva únicamente el environment
nombrado y sus bindings D1/`SITE_INDEXABLE`, de modo que Astro y Wrangler
seleccionan el mismo target. La compatibilidad segura requerida
(`compatibility_date` y `nodejs_compat`) permanece en el perfil saneado.

`.env.example` enumera los bindings sin valores. Los valores operativos se
inyectan desde el almacén de secretos del entorno, nunca mediante un archivo
`.dev.vars` persistente ni mediante el repositorio.

```bash
npm run deploy:dry
```

`deploy:dry` es una comprobación local y determinista del perfil del
repositorio: permite inspeccionar únicamente su UUID D1 local, deja una copia
saneada ignorada, ejecuta la build con esa copia y comprueba la topología
emitida. No invoca `wrangler deploy`, un cliente de red ni una acción externa;
no es una autorización de publicación.
