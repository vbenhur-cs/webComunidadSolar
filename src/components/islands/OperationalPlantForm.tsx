import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

const plantStudyForm =
  "https://forms.zohopublic.eu/comunidadsolar/form/ProyectosCEListosparagestionarV2/formperma/4gUsAsBhC1C4UXXZlRfTYYFd1yFpzSw_AQp6tTCSZ1Y";
const plantStudyEmbeddedForm =
  "https://forms.zohopublic.eu/comunidadsolar/form/ProyectosCEListosparagestionarV2/formperma/4gUsAsBhC1C4UXXZlRfTYYFd1yFpzSw_AQp6tTCSZ1Y?referrername=web-comunidades-energeticas-operativas";
const plantStudyEmbedId = "formulario-planta";

export function OperationalPlantFormEmbed() {
  const [ready, setReady] = useState(false);

  return (
    <section
      className="operational-form-embed"
      aria-labelledby="operational-form-embed-title"
    >
      <header>
        <div>
          <span>EVALUACIÓN DE ENCAJE · ACTIVOS DOCUMENTADOS</span>
          <h2 id="operational-form-embed-title">
            Cuéntanos los datos de tu planta.
          </h2>
          <p>
            El formulario se completa sin salir de Comunidad Solar. Ten a mano
            la información técnica, administrativa, energética y contractual del
            activo.
          </p>
        </div>
        <a
          href={plantStudyForm}
          target="_blank"
          rel="noreferrer"
          data-analytics-event="operational_plant_form_external_fallback"
        >
          Abrir en una pestaña nueva <span aria-hidden="true">↗</span>
        </a>
      </header>

      <div className={`operational-form-embed-body ${ready ? "is-ready" : ""}`}>
        {!ready && (
          <div className="operational-form-embed-loading" role="status">
            <i aria-hidden="true" />
            <span>Cargando el formulario seguro…</span>
          </div>
        )}
        <iframe
          src={plantStudyEmbeddedForm}
          title="Formulario para analizar una planta fotovoltaica operativa"
          loading="eager"
          referrerPolicy="strict-origin-when-cross-origin"
          scrolling="no"
          onLoad={() => setReady(true)}
        />
      </div>

      <footer>
        La solicitud no implica la aceptación del activo ni una oferta
        económica. Trataremos tus datos conforme a nuestra{" "}
        <a href="/politica-privacidad">política de privacidad</a>.
      </footer>
    </section>
  );
}

export function OperationalPlantForm() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);

  const reveal = useCallback(() => {
    const formTarget = document.getElementById(plantStudyEmbedId);
    if (formTarget === null) return;

    formTarget.hidden = false;
    setTarget(formTarget);
    setVisible(true);
    window.setTimeout(() => {
      formTarget.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }, []);

  useEffect(() => {
    if (window.location.hash === `#${plantStudyEmbedId}`) {
      const revealTimer = window.setTimeout(reveal, 0);
      return () => window.clearTimeout(revealTimer);
    }

    return undefined;
  }, [reveal]);

  useEffect(() => {
    const onDocumentClick = (event: MouseEvent) => {
      const origin = event.target;
      if (!(origin instanceof Element)) return;
      const trigger = origin.closest<HTMLAnchorElement>(
        `a[aria-controls="${plantStudyEmbedId}"]`,
      );
      if (trigger === null) return;

      event.preventDefault();
      reveal();
    };

    document.addEventListener("click", onDocumentClick);
    return () => document.removeEventListener("click", onDocumentClick);
  }, [reveal]);

  return (
    <>
      <a
        className="button button-primary"
        href={plantStudyForm}
        data-analytics-event="operational_plant_study_open"
        aria-controls={plantStudyEmbedId}
      >
        <span>Analizar el encaje de mi planta</span>
        <span aria-hidden="true">↗</span>
      </a>
      {visible &&
        target !== null &&
        createPortal(<OperationalPlantFormEmbed />, target)}
    </>
  );
}

export const operationalPlantStudyForm = plantStudyForm;
export const operationalPlantStudyEmbedId = plantStudyEmbedId;
