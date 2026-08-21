import { useState } from "react";
import {
  communities as sourceCommunities,
  type Community,
} from "../../content/community-data";

const heliosCoverageCalculator =
  "https://calculadoraenergetica.comunidadsolar.es";

export interface CoverageFinderProps {
  compact?: boolean;
  community?: Community;
  communities?: Community[];
  initialSlug?: string;
}

function communityHref(community: Pick<Community, "slug">): string {
  return `/comunidades-energeticas/${community.slug}`;
}

export function CoverageFinder({
  compact = false,
  community,
  communities = sourceCommunities,
  initialSlug,
}: CoverageFinderProps) {
  const participationIsFull = /participación completa/i.test(
    community?.commercialStatus ?? "",
  );
  const participationIsInterestOnly =
    /lista de espera|próxima apertura|aún no abierta/i.test(
      community?.commercialStatus ?? "",
    );
  const defaultCommunity =
    communities.find((item) => item.slug === initialSlug) ??
    communities.find((item) => item.slug === "villaverde-getafe") ??
    communities[0];

  if (defaultCommunity === undefined) return null;

  const [selectedCommunitySlug, setSelectedCommunitySlug] = useState(
    defaultCommunity.slug,
  );

  const intro = (
    <div className="coverage-intro">
      <span className="pill pill-green">
        La mejor solución empieza por tu dirección
      </span>
      <h2>
        {community
          ? `¿Tu dirección tiene cobertura en ${community.name}?`
          : "¿Hay una comunidad energética cerca de ti?"}
      </h2>
      {community ? (
        <p>
          {participationIsFull
            ? `Helios comprobará tu dirección y buscará la mejor alternativa disponible si la participación de ${community.name} continúa completa.`
            : participationIsInterestOnly
              ? `Helios comprobará si tu dirección puede encajar en ${community.name} y te permitirá apuntarte a la lista de espera. Cuando confirmemos las condiciones, podremos preparar tu propuesta.`
              : `Helios comprobará si alguna de las instalaciones de ${community.name} puede compartir energía con tu punto de suministro.`}
        </p>
      ) : null}
    </div>
  );

  const form = (
    <div className="coverage-form coverage-form-live">
      <span className="coverage-form-kicker">Calculadora de cobertura</span>
      <h3>
        {community
          ? participationIsFull
            ? "Comprueba tu dirección y recibe la mejor alternativa disponible."
            : participationIsInterestOnly
              ? `Comprueba si tienes cobertura en ${community.name} y apúntate a la lista de espera.`
              : `Comprueba tu dirección y recibe una propuesta para ${community.name}.`
          : "Comprueba tu cobertura y recibe una propuesta personalizada."}
      </h3>
      <p>
        {participationIsInterestOnly
          ? "Introduce tus datos y tu dirección. Helios comprobará la cobertura y registrará tu interés. Te avisaremos cuando estén confirmados el calendario, la cuota o el precio y las demás condiciones de participación."
          : "Introduce tus datos y tu dirección. Helios comprobará automáticamente si tienes una comunidad energética cerca. Si tienes cobertura, te pedirá una factura para analizar tu consumo y generar una propuesta personalizada. Con ese resultado te mostrará la solución que mejor encaja: compra o alquiler en una comunidad cercana, o Autoconsumo Remoto si no hay cobertura."}
      </p>
      <ol
        className="coverage-calculator-steps"
        aria-label="Pasos de la calculadora"
      >
        <li>
          <span>1</span>
          <div>
            <strong>Tu dirección</strong>
            <small>Comprobamos la cobertura</small>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            <strong>
              {participationIsInterestOnly ? "Tus datos" : "Tu factura"}
            </strong>
            <small>
              {participationIsInterestOnly
                ? "Registramos tu interés"
                : "Analizamos tu consumo"}
            </small>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <strong>
              {participationIsInterestOnly ? "Lista de espera" : "Tu propuesta"}
            </strong>
            <small>
              {participationIsInterestOnly
                ? "Te avisamos al abrir"
                : "Compra, alquiler o Remoto"}
            </small>
          </div>
        </li>
      </ol>
      <a
        className="coverage-submit-link"
        data-analytics-event="coverage_calculator_open"
        data-community-origin={community?.slug}
        href={heliosCoverageCalculator}
        target="_blank"
        rel="noreferrer"
      >
        {participationIsInterestOnly
          ? "Comprobar cobertura y apuntarme"
          : "Comprobar mi cobertura"}{" "}
        <span aria-hidden="true">→</span>
      </a>
      <small className="integration-note">
        Proceso automático de Comunidad Solar · Empezar no implica contratar.
      </small>
    </div>
  );

  if (compact) {
    return (
      <div className="coverage-finder coverage-compact">
        {intro}
        {form}
      </div>
    );
  }

  return (
    <div className="coverage-finder coverage-finder-map">
      <div className="coverage-search-panel">
        {intro}
        {form}
      </div>
      <SpainCommunitiesMap
        communities={communities}
        selectedSlug={selectedCommunitySlug}
        onSelect={(item) => setSelectedCommunitySlug(item.slug)}
      />
    </div>
  );
}

interface SpainCommunitiesMapProps {
  communities: Community[];
  selectedSlug: string;
  onSelect: (community: Community) => void;
}

function SpainCommunitiesMap({
  communities,
  selectedSlug,
  onSelect,
}: SpainCommunitiesMapProps) {
  const selected =
    communities.find((community) => community.slug === selectedSlug) ??
    communities[0];

  if (selected === undefined) return null;

  return (
    <aside
      className="coverage-map"
      aria-label="Mapa de comunidades energéticas"
    >
      <div className="coverage-map-head">
        <div>
          <p className="eyebrow">Nuestra red</p>
          <h3>Comunidades que acercan la energía a las personas.</h3>
        </div>
        <span>{communities.length} comunidades con ficha</span>
      </div>

      <div className="community-map-canvas">
        <svg
          viewBox="0 0 760 500"
          role="img"
          aria-labelledby="community-map-title community-map-description"
        >
          <title id="community-map-title">
            Mapa de comunidades energéticas en España
          </title>
          <desc id="community-map-description">
            Mapa ilustrativo con ubicaciones de comunidades energéticas de
            Comunidad Solar.
          </desc>
          <defs>
            <pattern
              id="community-map-grid"
              width="28"
              height="28"
              patternUnits="userSpaceOnUse"
            >
              <circle cx="2" cy="2" r="1.4" fill="currentColor" />
            </pattern>
          </defs>
          <rect
            className="community-map-grid"
            x="0"
            y="0"
            width="760"
            height="500"
            fill="url(#community-map-grid)"
          />
          <path
            className="community-map-mainland"
            d="M88 122C106 94 139 79 171 92L215 77C264 65 312 78 346 72L405 90 457 83 501 105 558 108 600 132 628 165 613 198 634 232 606 260 591 304 557 327 522 361 471 375 425 397 373 388 323 410 270 403 218 386 176 351 147 314 157 282 139 245 150 211 128 186 101 171Z"
          />
          <path
            className="community-map-portugal"
            d="M104 171C125 181 142 191 150 211L139 245 157 282 147 314 161 333 147 350 126 331 116 297 121 260 111 225 119 196Z"
          />
          <path
            className="community-map-island"
            d="M661 213c15-9 31-7 40 4-4 12-18 18-36 15-8-5-9-12-4-19Z"
          />
          <path
            className="community-map-island"
            d="M712 196c10-5 22-3 29 5-5 8-17 11-29 7-4-4-4-8 0-12Z"
          />
          <path
            className="community-map-island"
            d="M638 247c8-7 20-6 27 2-2 9-12 14-23 11-6-3-7-8-4-13Z"
          />
          <g className="community-map-canaries" aria-hidden="true">
            <rect x="42" y="410" width="190" height="62" rx="24" />
            <path d="M67 444c10-10 24-10 31-1-4 10-17 15-28 10-5-2-6-6-3-9Z" />
            <path d="M114 437c8-7 18-6 24 2-3 8-12 11-20 8-5-2-6-6-4-10Z" />
            <path d="M157 449c10-8 22-6 28 3-5 8-16 11-26 7-5-3-6-6-2-10Z" />
            <path d="M198 435c7-6 17-5 23 2-3 7-12 10-20 7-4-2-5-5-3-9Z" />
          </g>
        </svg>

        {communities.map((community) => {
          const active = community.slug === selected.slug;
          return (
            <button
              type="button"
              key={community.slug}
              className={`community-map-marker ${active ? "active" : ""}`}
              style={{
                left: `${community.map.x}%`,
                top: `${community.map.y}%`,
              }}
              aria-label={`${community.name}, ${community.province}`}
              aria-pressed={active}
              onClick={() => onSelect(community)}
            >
              <span>{community.name}</span>
            </button>
          );
        })}
      </div>

      <div className="coverage-map-detail" aria-live="polite">
        <span className="map-detail-dot" />
        <div>
          <small>
            {selected.province} · {selected.status}
          </small>
          <strong>{selected.name}</strong>
          <p>{selected.summary}</p>
        </div>
        <a
          className="coverage-map-detail-link"
          href={communityHref(selected)}
          aria-label={`Ver la ficha completa de ${selected.name}`}
        >
          <span aria-hidden="true">→</span>
        </a>
      </div>

      <p className="coverage-map-note">
        Mapa de ubicaciones publicadas. La cobertura final depende de tu punto
        de suministro y se confirma tras comprobar la dirección.
      </p>
    </aside>
  );
}
