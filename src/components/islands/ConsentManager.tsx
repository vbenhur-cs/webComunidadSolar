import { useEffect, useRef, useState } from "react";

import { openCookieSettingsEvent } from "../../scripts/cookie-settings";

const consentStorageKey = "comunidad-solar-cookie-consent-v1";
const gaMeasurementId = "G-EE5NXKDT7G";

type ConsentChoice = "necessary" | "analytics";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

function eventNameForLink(link: HTMLAnchorElement) {
  const href = link.href;
  const explicitEvent = link.dataset.analyticsEvent;

  if (explicitEvent) return explicitEvent;
  if (href.includes("zohobookings")) return "advisor_booking_click";
  if (href.includes("calculadorabaterias.comunidadsolar.es")) {
    return "battery_calculator_open";
  }
  if (
    href.includes("AnfitrinSolarCE") ||
    href.includes("ProyectosCEListosparagestionar")
  ) {
    return "asset_form_click";
  }
  if (href.includes("clever.gy") || href.includes("/soy-comunero")) {
    return "member_access_click";
  }
  if (href.includes("ayuda.comunidadsolar.es")) return "support_click";
  if (href.startsWith("https://wa.me/")) return "whatsapp_click";
  if (href.startsWith("tel:")) return "phone_click";

  return null;
}

function loadAnalytics() {
  if (document.querySelector(`script[data-ga-id="${gaMeasurementId}"]`)) return;

  window.dataLayer = window.dataLayer ?? [];
  window.gtag = (...args: unknown[]) => {
    window.dataLayer?.push(args);
  };
  window.gtag("js", new Date());
  window.gtag("consent", "default", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: "granted",
    functionality_storage: "granted",
    security_storage: "granted",
  });
  window.gtag("config", gaMeasurementId, {
    anonymize_ip: true,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    send_page_view: false,
  });

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${gaMeasurementId}`;
  script.dataset.gaId = gaMeasurementId;
  document.head.appendChild(script);
}

function clearAnalyticsCookies() {
  const names = document.cookie
    .split(";")
    .map((cookie) => cookie.split("=")[0]?.trim())
    .filter(
      (name): name is string =>
        Boolean(name) &&
        (/^_ga/.test(name) ||
          /^_gid$/.test(name) ||
          /^_gat/.test(name) ||
          /^_gac_/.test(name) ||
          /^_gcl_au$/.test(name) ||
          /^_fb[pc]$/.test(name) ||
          /^_ttp$/.test(name)),
    );
  const hostname = window.location.hostname.replace(/^www\./, "");

  for (const name of names) {
    document.cookie = `${name}=; Max-Age=0; path=/; SameSite=Lax`;
    document.cookie = `${name}=; Max-Age=0; path=/; domain=.${hostname}; SameSite=Lax`;
  }
}

export function ConsentManager() {
  const pathname =
    typeof window === "undefined" ? "" : window.location.pathname;
  const privatePath =
    pathname === "/socios" ||
    pathname.startsWith("/socios/") ||
    pathname === "/guia-equipo";
  const panelRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [choice, setChoice] = useState<ConsentChoice | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      let storedChoice: string | null = null;
      try {
        storedChoice = window.localStorage.getItem(consentStorageKey);
      } catch {
        storedChoice = null;
      }
      if (storedChoice === "necessary" || storedChoice === "analytics") {
        setChoice(storedChoice);
      } else {
        setSettingsOpen(true);
      }
    });

    const openSettings = () => {
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setSettingsOpen(true);
      window.requestAnimationFrame(() => panelRef.current?.focus());
    };
    window.addEventListener(openCookieSettingsEvent, openSettings);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener(openCookieSettingsEvent, openSettings);
    };
  }, []);

  useEffect(() => {
    if (choice !== "analytics" || privatePath) return;

    loadAnalytics();
    const trackKeyJourneys = (event: MouseEvent) => {
      const element = event.target;
      if (!(element instanceof Element)) return;
      const link = element.closest("a");
      if (!(link instanceof HTMLAnchorElement)) return;
      const analyticsEvent = eventNameForLink(link);
      if (!analyticsEvent) return;
      window.gtag?.("event", analyticsEvent, {
        link_url: link.href,
        link_text: link.textContent?.trim().replace(/\s+/g, " ").slice(0, 120),
      });
    };
    document.addEventListener("click", trackKeyJourneys);
    return () => document.removeEventListener("click", trackKeyJourneys);
  }, [choice, privatePath]);

  useEffect(() => {
    if (choice !== "analytics" || privatePath) return;
    window.gtag?.("event", "page_view", {
      page_location: window.location.href,
      page_path: pathname,
    });
  }, [choice, pathname, privatePath]);

  const saveChoice = (nextChoice: ConsentChoice) => {
    const mustReload = choice === "analytics" && nextChoice === "necessary";
    try {
      window.localStorage.setItem(consentStorageKey, nextChoice);
    } catch {
      // La preferencia sigue siendo válida durante la sesión actual.
    }
    setChoice(nextChoice);
    setSettingsOpen(false);
    if (nextChoice === "necessary") clearAnalyticsCookies();
    if (mustReload) {
      window.location.reload();
      return;
    }
    window.requestAnimationFrame(() => returnFocusRef.current?.focus());
  };

  if (!settingsOpen) return null;

  return (
    <aside
      ref={panelRef}
      className="consent-panel"
      role="region"
      tabIndex={-1}
      aria-live="polite"
      aria-labelledby="consent-title"
      aria-describedby="consent-copy"
    >
      {choice && (
        <button
          className="consent-close"
          type="button"
          aria-label="Cerrar preferencias de cookies"
          onClick={() => {
            setSettingsOpen(false);
            window.requestAnimationFrame(() => returnFocusRef.current?.focus());
          }}
        >
          ×
        </button>
      )}
      <div>
        <p className="consent-kicker">Tu privacidad</p>
        <h2 id="consent-title">Tú decides qué medimos.</h2>
        <p id="consent-copy">
          Usamos cookies necesarias para que la web funcione. Solo con tu
          permiso activamos analítica para entender qué recorridos resultan
          útiles y mejorar la atención.
        </p>
        {choice && (
          <p className="consent-current">
            Preferencia actual:{" "}
            <strong>
              {choice === "analytics"
                ? "analítica aceptada"
                : "solo cookies necesarias"}
            </strong>
          </p>
        )}
        <a href="/cookies">Consultar la política de cookies</a>
      </div>
      <div className="consent-actions">
        <button type="button" onClick={() => saveChoice("necessary")}>
          Rechazar analítica
        </button>
        <button
          className="consent-accept"
          type="button"
          onClick={() => saveChoice("analytics")}
        >
          Aceptar analítica
        </button>
      </div>
    </aside>
  );
}

export { openCookieSettings } from "../../scripts/cookie-settings";
