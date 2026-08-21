import { useState } from "react";

import {
  isCurrentPageLink,
  type HeaderPageKey,
} from "../../lib/site/page-registry";

const logo = "/comunidad-solar-logo.svg";

const navItems = [
  { href: "/nosotros", label: "Quiénes somos" },
  { href: "/blog", label: "Blog" },
  { href: "/contacto", label: "Contacto" },
] as const;

const solutionGroups = [
  {
    title: "Energía compartida",
    items: [
      {
        href: "/comunidades-energeticas",
        label: "Comunidades energéticas",
        note: "Compra o alquiler cerca de casa",
      },
      {
        href: "/autoconsumo-remoto",
        label: "Autoconsumo remoto",
        note: "Tu energía desde cualquier lugar",
      },
    ],
  },
  {
    title: "En tu hogar",
    items: [
      {
        href: "/autoconsumo-en-mi-tejado",
        label: "Instalación fotovoltaica",
        note: "Produce en tu propio tejado",
      },
      {
        href: "/baterias",
        label: "Baterías",
        note: "Con placas solares o sin ellas",
      },
      {
        href: "/aerotermia",
        label: "Aerotermia",
        note: "Climatización con Coolfy",
      },
    ],
  },
  {
    title: "Servicios",
    items: [
      {
        href: "/mantenimiento",
        label: "Mantenimiento",
        note: "Cuida el rendimiento de tu instalación",
      },
      {
        href: "/comercializadora-y-tarifas",
        label: "Comercializadora",
        note: "Tu producción llega a tu factura",
      },
    ],
  },
  {
    title: "Para propietarios",
    items: [
      {
        href: "/rentabiliza-tu-activo#cubierta",
        label: "Tengo una cubierta",
        note: "Cede tu tejado y genera ingresos",
      },
      {
        href: "/comunidades-energeticas-operativas",
        label: "Tengo una planta",
        note: "Nos ocupamos de su gestión y comercialización",
      },
    ],
  },
] as const;

export interface HeaderIslandProps {
  page: HeaderPageKey;
}

export function HeaderIsland({ page }: HeaderIslandProps) {
  const [open, setOpen] = useState(false);
  const [solutionsOpen, setSolutionsOpen] = useState(false);

  const closeMenus = () => {
    setOpen(false);
    setSolutionsOpen(false);
  };

  return (
    <>
      <a className="skip-link" href="#contenido-principal">
        Saltar al contenido
      </a>
      <div className="topline">
        <div className="shell topline-inner">
          <span className="topline-message">
            <i aria-hidden="true" />
            Energía independiente desde 2018
          </span>
          <span className="topline-stat">La energía de las personas</span>
        </div>
      </div>
      <header
        className="site-header"
        onKeyDown={(event) => {
          if (event.key === "Escape") closeMenus();
        }}
      >
        <div className="shell header-inner">
          <a className="brand" href="/" aria-label="Comunidad Solar, inicio">
            <img src={logo} alt="Comunidad Solar" />
          </a>
          <nav className="desktop-nav" aria-label="Navegación principal">
            <div
              className="solutions-menu"
              onMouseEnter={() => setSolutionsOpen(true)}
              onMouseLeave={() => setSolutionsOpen(false)}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  setSolutionsOpen(false);
                }
              }}
            >
              <button
                type="button"
                className="solutions-trigger"
                aria-expanded={solutionsOpen}
                aria-controls="solutions-panel"
                aria-haspopup="true"
                onClick={() => setSolutionsOpen((value) => !value)}
              >
                Soluciones <span aria-hidden="true">⌄</span>
              </button>
              <div
                id="solutions-panel"
                className={`solutions-panel solutions-panel-wide ${solutionsOpen ? "open" : ""}`}
                aria-hidden={!solutionsOpen}
                hidden={!solutionsOpen}
              >
                {solutionGroups.map((group) => (
                  <div className="solutions-group" key={group.title}>
                    <p>{group.title}</p>
                    {group.items.map((item) => {
                      const current = isCurrentPageLink(page, item.href);
                      return (
                        <a
                          key={item.label}
                          href={item.href}
                          className={current ? "active" : ""}
                          aria-current={current ? "page" : undefined}
                          onClick={() => setSolutionsOpen(false)}
                        >
                          <strong>{item.label}</strong>
                          <small>{item.note}</small>
                        </a>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
            {navItems.map((item) => {
              const current = isCurrentPageLink(page, item.href);
              return (
                <a
                  key={item.href}
                  href={item.href}
                  className={current ? "active" : ""}
                  aria-current={current ? "page" : undefined}
                >
                  {item.label}
                </a>
              );
            })}
          </nav>
          <div className="header-actions">
            <a
              className={`header-member ${page === "comunero" ? "active" : ""}`}
              href="/soy-comunero"
              aria-current={page === "comunero" ? "page" : undefined}
            >
              <span aria-hidden="true" />
              Soy comunero
            </a>
            <a className="header-cta" href="/comunidades-energeticas#cobertura">
              Comprueba tu cobertura <span aria-hidden="true">→</span>
            </a>
          </div>
          <button
            className="menu-button"
            type="button"
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? "Cerrar menú" : "Abrir menú"}
            onClick={() => setOpen((value) => !value)}
          >
            <span />
            <span />
          </button>
        </div>
        <nav
          id="mobile-menu"
          className={`mobile-nav ${open ? "open" : ""}`}
          aria-label="Navegación móvil"
          aria-hidden={!open}
          hidden={!open}
        >
          {navItems.map((item) => (
            <a
              key={item.href}
              href={item.href}
              aria-current={
                isCurrentPageLink(page, item.href) ? "page" : undefined
              }
              onClick={() => setOpen(false)}
            >
              {item.label}
            </a>
          ))}
          <p className="mobile-nav-title">Energía compartida</p>
          {solutionGroups[0].items.map((item) => (
            <a
              key={item.label}
              href={item.href}
              aria-current={
                isCurrentPageLink(page, item.href) ? "page" : undefined
              }
              onClick={() => setOpen(false)}
            >
              {item.label}
            </a>
          ))}
          <p className="mobile-nav-title">En tu hogar</p>
          {solutionGroups[1].items.map((item) => (
            <a
              key={item.label}
              href={item.href}
              aria-current={
                isCurrentPageLink(page, item.href) ? "page" : undefined
              }
              onClick={() => setOpen(false)}
            >
              {item.label}
            </a>
          ))}
          <p className="mobile-nav-title">Servicios</p>
          {solutionGroups[2].items.map((item) => (
            <a
              key={item.label}
              href={item.href}
              aria-current={
                isCurrentPageLink(page, item.href) ? "page" : undefined
              }
              onClick={() => setOpen(false)}
            >
              {item.label}
            </a>
          ))}
          <p className="mobile-nav-title">Para propietarios</p>
          {solutionGroups[3].items.map((item) => (
            <a
              key={item.label}
              href={item.href}
              aria-current={
                isCurrentPageLink(page, item.href) ? "page" : undefined
              }
              onClick={() => setOpen(false)}
            >
              {item.label}
            </a>
          ))}
          <a
            href="/comunidades-energeticas#cobertura"
            onClick={() => setOpen(false)}
          >
            Comprueba tu cobertura
          </a>
          <a
            href="/soy-comunero"
            aria-current={page === "comunero" ? "page" : undefined}
            onClick={() => setOpen(false)}
          >
            Soy comunero
          </a>
        </nav>
      </header>
    </>
  );
}
