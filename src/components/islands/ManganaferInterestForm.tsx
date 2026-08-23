import { useState, type SubmitEvent } from "react";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success" }
  | { status: "error"; message: string; field?: string };

function Arrow() {
  return <span aria-hidden="true">→</span>;
}

/**
 * The public interest flow is deliberately isolated from the landing shell.
 * Its initial form remains server-rendered; network work begins only on submit.
 */
export function ManganaferInterestForm() {
  const [submission, setSubmission] = useState<SubmissionState>({
    status: "idle",
  });

  async function submitInterest(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries()) as Record<
      string,
      FormDataEntryValue
    >;

    setSubmission({ status: "submitting" });

    try {
      const response = await fetch("/api/manganafer-interest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...payload,
          kind: "neighbor",
          privacyAccepted: formData.get("privacyAccepted") === "on",
        }),
      });
      const result = (await response.json()) as {
        ok?: boolean;
        error?: string;
        field?: string;
      };

      if (!response.ok || !result.ok) {
        setSubmission({
          status: "error",
          message:
            result.error ??
            "No hemos podido guardar tus datos. Inténtalo de nuevo.",
          field: result.field,
        });
        if (result.field) {
          window.setTimeout(() => {
            form
              .querySelector<HTMLElement>(`[name="${result.field}"]`)
              ?.focus();
          }, 0);
        }
        return;
      }

      form.reset();
      setSubmission({ status: "success" });
    } catch {
      setSubmission({
        status: "error",
        message:
          "No hemos podido conectar con el formulario. Revisa tu conexión e inténtalo de nuevo.",
      });
    }
  }

  if (submission.status === "success") {
    return (
      <div className="manganafer-form-success" role="status">
        <span aria-hidden="true">✓</span>
        <p className="eyebrow">Registro completado</p>
        <h3>Ya formas parte de la lista de interesados.</h3>
        <p>
          Te escribiremos cuando exista una novedad relevante o necesitemos
          completar la información.
        </p>
        <button type="button" onClick={() => setSubmission({ status: "idle" })}>
          Enviar otro registro <Arrow />
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submitInterest} noValidate>
      <div className="manganafer-form-heading">
        <span>Hogar o negocio</span>
        <h3>Quiero recibir información y tener prioridad.</h3>
      </div>

      <div className="manganafer-form-grid">
        <label>
          <span>Nombre</span>
          <input name="firstName" autoComplete="given-name" required />
        </label>
        <label>
          <span>Apellidos</span>
          <input name="lastName" autoComplete="family-name" required />
        </label>
        <label>
          <span>Correo electrónico</span>
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          <span>Teléfono</span>
          <input
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            required
          />
        </label>
        <label>
          <span>Municipio o diputación</span>
          <input
            name="municipality"
            autoComplete="address-level2"
            placeholder="Ej. Cartagena, Los Belones…"
            required
          />
        </label>
        <label>
          <span>Código postal</span>
          <input
            name="postalCode"
            inputMode="numeric"
            pattern="[0-9]{5}"
            maxLength={5}
            autoComplete="postal-code"
            required
          />
        </label>
        <label className="manganafer-form-full">
          <span>Dirección o zona aproximada</span>
          <input
            name="address"
            autoComplete="street-address"
            placeholder="Nos ayudará a orientar si estás dentro del radio de 1 km"
          />
        </label>

        <label className="manganafer-form-full">
          <span>¿Quién participaría?</span>
          <select name="participantProfile" required defaultValue="">
            <option value="" disabled>
              Selecciona una opción
            </option>
            <option value="hogar">Mi hogar</option>
            <option value="negocio">Mi negocio o empresa</option>
            <option value="asociacion">Una asociación o entidad</option>
            <option value="otro">Otro</option>
          </select>
        </label>

        <label className="manganafer-form-full">
          <span>¿Quieres añadir algo?</span>
          <textarea
            name="message"
            rows={4}
            maxLength={1200}
            placeholder="Cuéntanos tus dudas o qué te gustaría saber."
          />
        </label>
      </div>

      <label className="manganafer-honeypot" aria-hidden="true">
        Sitio web
        <input name="website" type="text" tabIndex={-1} autoComplete="off" />
      </label>

      <label className="manganafer-consent">
        <input name="privacyAccepted" type="checkbox" required />
        <span>
          Autorizo a Comunidad Solar a guardar estos datos y contactarme sobre
          la Comunidad Energética de Manganáfer. He leído la{" "}
          <a href="/politica-privacidad">política de privacidad</a>.
        </span>
      </label>

      {submission.status === "error" && (
        <div className="manganafer-form-error" role="alert">
          {submission.message}
        </div>
      )}

      <button
        className="button button-primary manganafer-form-submit"
        type="submit"
        disabled={submission.status === "submitting"}
        data-analytics-event="manganafer_neighbor_submit"
      >
        {submission.status === "submitting"
          ? "Guardando…"
          : "Quiero formar parte"}{" "}
        <Arrow />
      </button>
      <small className="manganafer-form-footnote">
        Este registro no es una contratación ni garantiza plaza, cobertura o
        condiciones concretas.
      </small>
    </form>
  );
}
