import { useRef, useState, type SubmitEvent } from "react";

type QuoteEstimate = {
  panels: number;
  annualSaving: number;
  monthlySaving: number;
  savingPercentage: number;
  currentAnnualBill: number;
  estimatedAnnualBill: number;
  projectSaving: number;
  monthlyFee: number;
  annualSolarEnergyKwh: number;
  projectYears: number;
};

type QuoteState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "outside"; distanceMetres: number }
  | { status: "not-calculable"; distanceMetres: number }
  | {
      status: "success";
      distanceMetres: number;
      estimate: QuoteEstimate;
    }
  | { status: "error"; message: string };

function Arrow() {
  return <span aria-hidden="true">→</span>;
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDecimal(value: number) {
  return new Intl.NumberFormat("es-ES", {
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * Owns only the calculator's browser state and submit handler. It server-renders
 * the initial form so the landing retains its complete static story without JS.
 */
export function ManganaferQuoteForm() {
  const [quote, setQuote] = useState<QuoteState>({ status: "idle" });
  const cupsInputRef = useRef<HTMLInputElement>(null);

  async function submitQuote(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const cups = String(formData.get("cups") ?? "");

    setQuote({ status: "submitting" });

    try {
      const response = await fetch("/api/manganafer-quote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ cups }),
      });
      const result = (await response.json()) as {
        ok?: boolean;
        eligible?: boolean;
        calculable?: boolean;
        distanceMetres?: number;
        estimate?: QuoteEstimate;
        error?: string;
      };

      if (!response.ok || !result.ok) {
        setQuote({
          status: "error",
          message:
            result.error ??
            "No hemos podido preparar la estimación. Inténtalo de nuevo.",
        });
        window.setTimeout(() => cupsInputRef.current?.focus(), 0);
        return;
      }

      const distanceMetres = Number(result.distanceMetres ?? 0);
      if (result.eligible === false) {
        setQuote({ status: "outside", distanceMetres });
        return;
      }
      if (result.calculable === false || !result.estimate) {
        setQuote({ status: "not-calculable", distanceMetres });
        return;
      }

      setQuote({
        status: "success",
        distanceMetres,
        estimate: result.estimate,
      });
    } catch {
      setQuote({
        status: "error",
        message:
          "No hemos podido conectar con la calculadora. Inténtalo de nuevo en unos minutos.",
      });
      window.setTimeout(() => cupsInputRef.current?.focus(), 0);
    }
  }

  return (
    <>
      <div className="manganafer-calculator-copy">
        <p className="eyebrow">Tu caso, con tus propios datos</p>
        <h2>Introduce tu CUPS y descubre cómo podría quedar tu ahorro.</h2>
        <p>
          Utilizamos el mismo motor de nuestra calculadora energética para
          comprobar si tu suministro entra en el ámbito de Manganáfer y preparar
          una estimación personalizada.
        </p>
        <form
          className="manganafer-calculator-form"
          onSubmit={submitQuote}
          noValidate
        >
          <label htmlFor="manganafer-cups">
            <span>CUPS del punto de suministro</span>
            <small id="manganafer-cups-help">
              Empieza por ES y aparece en cualquier factura de electricidad.
            </small>
          </label>
          <div className="manganafer-calculator-control">
            <input
              ref={cupsInputRef}
              id="manganafer-cups"
              name="cups"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={22}
              placeholder="ES00 0000 0000 0000 00XX"
              aria-describedby="manganafer-cups-help manganafer-cups-privacy"
              aria-invalid={quote.status === "error"}
              required
            />
            <button
              className="button button-primary"
              type="submit"
              disabled={quote.status === "submitting"}
            >
              {quote.status === "submitting"
                ? "Calculando…"
                : "Ver mi estimación"}{" "}
              <Arrow />
            </button>
          </div>
          <small
            className="manganafer-calculator-privacy"
            id="manganafer-cups-privacy"
          >
            El CUPS se usa solo para esta consulta. No lo guardamos ni lo
            enviamos a analítica.
          </small>
        </form>
      </div>

      <div
        className={`manganafer-calculator-result manganafer-calculator-result-${quote.status}`}
        aria-live="polite"
      >
        {quote.status === "idle" || quote.status === "submitting" ? (
          <ol className="manganafer-calculator-steps">
            <li>
              <span>01</span>
              <div>
                <strong>Introduce el CUPS</strong>
                <p>Lo encontrarás en cualquier factura de electricidad.</p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <strong>Confirmamos el radio de 1 km</strong>
                <p>
                  La calculadora comprueba si el punto de suministro entra en el
                  ámbito de Manganáfer.
                </p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <strong>Ves un ejemplo de ahorro</strong>
                <p>
                  Recibes una estimación basada en los datos de tu consumo y en
                  las condiciones previstas.
                </p>
              </div>
            </li>
          </ol>
        ) : quote.status === "success" ? (
          <div className="manganafer-quote-success">
            <div className="manganafer-quote-status">
              <span aria-hidden="true">✓</span>
              <div>
                <small>Tu suministro está dentro</small>
                <strong>
                  Aproximadamente a {quote.distanceMetres} m del proyecto
                </strong>
              </div>
            </div>
            <p className="eyebrow">Ejemplo personalizado de ahorro</p>
            <div className="manganafer-quote-primary">
              <small>Ahorro estimado al año</small>
              <strong>{formatCurrency(quote.estimate.annualSaving)}</strong>
              <span>
                {formatCurrency(quote.estimate.monthlySaving)} al mes ·{" "}
                {formatDecimal(quote.estimate.savingPercentage)}%
              </span>
            </div>
            <dl className="manganafer-quote-breakdown">
              <div>
                <dt>Paneles asignados</dt>
                <dd>{quote.estimate.panels}</dd>
              </div>
              <div>
                <dt>Cuota mensual estimada</dt>
                <dd>{formatCurrency(quote.estimate.monthlyFee)}</dd>
              </div>
              <div>
                <dt>Factura anual actual</dt>
                <dd>{formatCurrency(quote.estimate.currentAnnualBill)}</dd>
              </div>
              <div>
                <dt>Factura anual estimada</dt>
                <dd>{formatCurrency(quote.estimate.estimatedAnnualBill)}</dd>
              </div>
              <div>
                <dt>Energía solar anual</dt>
                <dd>
                  {formatDecimal(quote.estimate.annualSolarEnergyKwh)} kWh
                </dd>
              </div>
              <div>
                <dt>Ahorro en {quote.estimate.projectYears} años</dt>
                <dd>{formatCurrency(quote.estimate.projectSaving)}</dd>
              </div>
            </dl>
            <p className="manganafer-quote-disclaimer">
              Esta es una estimación orientativa, no una oferta contractual. Las
              condiciones definitivas se confirmarán antes de que decidas.
            </p>
            <a
              className="button button-primary"
              href="#registro-manganafer"
              data-analytics-event="manganafer_quote_interest"
            >
              Quiero tener prioridad <Arrow />
            </a>
          </div>
        ) : quote.status === "outside" ? (
          <div className="manganafer-quote-message">
            <span aria-hidden="true">↗</span>
            <p className="eyebrow">Fuera del ámbito de Manganáfer</p>
            <h3>Este CUPS no está dentro del radio de 1 km.</h3>
            <p>
              La distancia orientativa al proyecto es de {quote.distanceMetres}{" "}
              m. Puedes comprobar otras comunidades energéticas disponibles para
              tu zona.
            </p>
            <a
              className="button button-secondary"
              href="/comunidades-energeticas"
            >
              Ver otras comunidades <Arrow />
            </a>
          </div>
        ) : quote.status === "not-calculable" ? (
          <div className="manganafer-quote-message">
            <span aria-hidden="true">✓</span>
            <p className="eyebrow">Dentro del ámbito de Manganáfer</p>
            <h3>Tu CUPS está dentro, pero necesitamos revisar el caso.</h3>
            <p>
              El cálculo automático no ha encontrado una combinación que podamos
              recomendarte con seguridad. Déjanos tus datos y lo estudiaremos
              contigo.
            </p>
            <a className="button button-primary" href="#registro-manganafer">
              Pedir una revisión <Arrow />
            </a>
          </div>
        ) : (
          <div className="manganafer-quote-message manganafer-quote-error">
            <span aria-hidden="true">!</span>
            <p className="eyebrow">No hemos podido calcularlo</p>
            <h3>{quote.message}</h3>
            <p>
              Puedes volver a comprobar el CUPS o dejar tus datos para que
              revisemos la cobertura contigo.
            </p>
            <a className="button button-secondary" href="#registro-manganafer">
              Dejar mis datos <Arrow />
            </a>
          </div>
        )}
      </div>
    </>
  );
}
