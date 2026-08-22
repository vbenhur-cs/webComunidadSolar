import { useState } from "react";

const remoteMediaReelVideoId = "1145233162";
const remoteMediaReelPoster = "/media/cs-medios-2025-poster-antena3.jpg";

export interface RemoteVideoProps {
  variant?: "hero" | "library";
  provider?: "youtube" | "vimeo";
  videoId?: string;
  title?: string;
  label?: string;
  description?: string;
  poster?: string;
  featured?: boolean;
}

export function RemoteVideo({
  variant = "library",
  provider = "vimeo",
  videoId,
  title,
  label,
  description,
  poster,
  featured = false,
}: RemoteVideoProps) {
  const [isPlaying, setIsPlaying] = useState(false);

  if (variant === "hero") {
    const embedUrl = `https://player.vimeo.com/video/${remoteMediaReelVideoId}?autoplay=1&title=0&byline=0&portrait=0`;

    return (
      <article
        className="remote-hero-video-card"
        data-remote-hero-video={remoteMediaReelVideoId}
        aria-label="Reel de apariciones de Comunidad Solar en televisión"
      >
        <div className="remote-hero-video-bar">
          <span>
            <i aria-hidden="true" />
            Autoconsumo Remoto en Antena 3
          </span>
          <small>00:43</small>
        </div>
        <div className="remote-hero-video-stage">
          {isPlaying ? (
            <iframe
              src={embedUrl}
              title="Comunidad Solar en televisión: reel de apariciones en medios"
              allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
              allowFullScreen
            />
          ) : (
            <button
              type="button"
              onClick={() => setIsPlaying(true)}
              aria-label="Reproducir el reel de apariciones de Comunidad Solar en televisión"
            >
              <img src={remoteMediaReelPoster} alt="" loading="eager" />
              <span className="remote-hero-video-play" aria-hidden="true">
                ▶
              </span>
              <small>Ver el reel de medios</small>
            </button>
          )}
        </div>
        <div className="remote-hero-video-caption">
          <div>
            <span>VISTO EN ANTENA 3</span>
            <strong>
              La idea que cambió las reglas: tus paneles, aunque no tengas
              tejado.
            </strong>
          </div>
          <a
            href={`https://vimeo.com/${remoteMediaReelVideoId}`}
            target="_blank"
            rel="noreferrer"
            aria-label="Abrir el reel de Comunidad Solar en Vimeo"
          >
            Ver en Vimeo <span aria-hidden="true">↗</span>
          </a>
        </div>
      </article>
    );
  }

  if (
    videoId === undefined ||
    title === undefined ||
    label === undefined ||
    description === undefined ||
    poster === undefined
  ) {
    return null;
  }

  const embedUrl =
    provider === "youtube"
      ? `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0`
      : `https://player.vimeo.com/video/${videoId}?autoplay=1&title=0&byline=0&portrait=0`;
  const externalUrl =
    provider === "youtube"
      ? `https://www.youtube.com/watch?v=${videoId}`
      : `https://vimeo.com/${videoId}`;

  return (
    <article
      className={`remote-video-card ${featured ? "remote-video-card-featured" : ""}`}
      data-remote-video={videoId}
    >
      <div className="remote-video-frame">
        {isPlaying ? (
          <iframe
            src={embedUrl}
            title={title}
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
          />
        ) : (
          <button
            type="button"
            onClick={() => setIsPlaying(true)}
            aria-label={`Reproducir: ${title}`}
          >
            <img src={poster} alt="" loading="lazy" />
            <span className="remote-video-play" aria-hidden="true">
              ▶
            </span>
            <small>Reproducir vídeo</small>
          </button>
        )}
      </div>
      <div className="remote-video-copy">
        <span>{label}</span>
        <h3>{title}</h3>
        <p>{description}</p>
        <a href={externalUrl} target="_blank" rel="noreferrer">
          Abrir el vídeo en una pestaña nueva <span aria-hidden="true">↗</span>
        </a>
      </div>
    </article>
  );
}
