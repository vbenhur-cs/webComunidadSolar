import { useEffect, useState } from "react";

const aboutLegacyVideoId = "1093023979";
const aboutLegacyVideoHash = "adde7c847f";
const aboutLegacyVideoPoster = "/media/damian-villa-por-el-planeta.jpg";

export function AboutVideo() {
  const [isVideoOpen, setIsVideoOpen] = useState(false);
  const embedUrl = `https://player.vimeo.com/video/${aboutLegacyVideoId}?h=${aboutLegacyVideoHash}&autoplay=1&title=0&byline=0&portrait=0`;

  useEffect(() => {
    if (!isVideoOpen) return;

    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsVideoOpen(false);
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [isVideoOpen]);

  return (
    <section
      className="about-hero"
      aria-labelledby="about-hero-title"
      data-about-video={aboutLegacyVideoId}
    >
      <div className="about-hero-scene">
        <div className="about-hero-copy">
          <p className="about-hero-eyebrow">
            <span>Quiénes somos</span>
            <strong>#PorElPlaneta</strong>
          </p>
          <h1 id="about-hero-title">
            La energía que elegimos hoy cambia el mundo que dejamos mañana.
          </h1>
          <p className="about-hero-lead">
            Comunidad Solar nació para que producir, compartir y almacenar
            energía limpia fuera algo que pudiéramos hacer juntos. Por nuestro
            bolsillo. Por nuestra independencia. Por el planeta.
          </p>
          <div className="hero-actions about-hero-actions">
            <a className="button button-primary" href="#historia">
              <span>Conoce nuestra historia</span>
              <span aria-hidden="true">↗</span>
            </a>
            <button
              type="button"
              className="button button-secondary about-hero-video-cta"
              onClick={() => setIsVideoOpen(true)}
              aria-controls="about-legacy-video-dialog"
            >
              <span>Ver el vídeo</span>
              <span aria-hidden="true">▶</span>
            </button>
          </div>
        </div>
        <div className="about-hero-media">
          <button
            type="button"
            className="about-hero-poster-button"
            onClick={() => setIsVideoOpen(true)}
            aria-label="Ver Hay decisiones que iluminan el futuro, con Damián Villa"
            aria-controls="about-legacy-video-dialog"
          >
            <img
              src={aboutLegacyVideoPoster}
              alt=""
              loading="eager"
              fetchPriority="high"
            />
            <span className="about-hero-video-shade" aria-hidden="true" />
            <span className="about-hero-damian">
              <strong>Damián Villa</strong>
              <small>Comunero desde 2021</small>
            </span>
            <span className="about-hero-play" aria-hidden="true">
              ▶
            </span>
            <span className="about-hero-film-title">
              Hay decisiones que
              <strong>iluminan el futuro</strong>
            </span>
          </button>
        </div>
        <svg
          className="about-hero-energy"
          viewBox="0 0 1440 720"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path
            className="about-hero-energy-halo"
            d="M0 635C245 570 375 535 525 548C675 560 774 620 902 592C985 574 1032 514 1092 498"
          />
          <path
            className="about-hero-energy-line"
            d="M0 635C245 570 375 535 525 548C675 560 774 620 902 592C985 574 1032 514 1092 498"
          />
          <circle className="about-hero-energy-spark" r="7">
            <animateMotion
              dur="6.8s"
              repeatCount="indefinite"
              path="M0 635C245 570 375 535 525 548C675 560 774 620 902 592C985 574 1032 514 1092 498"
            />
          </circle>
        </svg>
      </div>
      <a className="about-hero-next" href="#historia">
        <span aria-hidden="true" />
        Nuestra historia
        <span aria-hidden="true" />
      </a>
      {isVideoOpen ? (
        <div
          className="about-video-dialog-backdrop"
          id="about-legacy-video-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="about-video-dialog-title"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setIsVideoOpen(false);
          }}
        >
          <div className="about-video-dialog">
            <div className="about-video-dialog-head">
              <div>
                <span>#PorElPlaneta</span>
                <strong id="about-video-dialog-title">
                  Hay decisiones que iluminan el futuro
                </strong>
              </div>
              <button
                type="button"
                onClick={() => setIsVideoOpen(false)}
                aria-label="Cerrar el vídeo"
                autoFocus
              >
                ×
              </button>
            </div>
            <div className="about-video-dialog-frame">
              <iframe
                src={embedUrl}
                title="Hay decisiones que iluminan el futuro, con Damián Villa"
                allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                allowFullScreen
              />
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
