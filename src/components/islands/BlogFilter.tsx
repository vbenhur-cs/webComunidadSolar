import { useState } from "react";

import {
  blogCategories,
  blogPosts,
  type BlogCategory,
  type BlogPost,
} from "../../content/blog-data";

export interface BlogFilterProps {
  posts?: BlogPost[];
}

function BlogCard({
  post,
  hidden = false,
}: {
  post: BlogPost;
  hidden?: boolean;
}) {
  return (
    <article
      className="blog-card"
      data-blog-post
      data-blog-category={post.category}
      hidden={hidden}
      aria-hidden={hidden}
    >
      <a
        className={`blog-card-image ${
          post.format === "Archivo de evento" ? "blog-card-image-event" : ""
        }`}
        href={`/blog/${post.slug}`}
      >
        <img src={post.image} alt={post.imageAlt} loading="lazy" />
        <span className="blog-card-format">{post.format}</span>
      </a>
      <div className="blog-card-body">
        <div className="blog-card-meta">
          <span>{post.category}</span>
          <time dateTime={post.date}>{post.displayDate}</time>
        </div>
        <h3>
          <a href={`/blog/${post.slug}`}>{post.title}</a>
        </h3>
        <p>{post.excerpt}</p>
        <a className="blog-card-link" href={`/blog/${post.slug}`}>
          Leer la historia <span aria-hidden="true">↗</span>
        </a>
      </div>
    </article>
  );
}

export function BlogFilter({ posts = blogPosts }: BlogFilterProps) {
  const [activeCategory, setActiveCategory] = useState<"Todos" | BlogCategory>(
    "Todos",
  );
  const visiblePosts =
    activeCategory === "Todos"
      ? posts
      : posts.filter((post) => post.category === activeCategory);

  return (
    <>
      <div className="blog-archive-heading">
        <div className="section-heading section-heading-left">
          <p className="eyebrow">Archivo vivo</p>
          <h2>La historia completa, sin borrar el camino.</h2>
          <p className="section-copy">
            Las piezas recuperadas mantienen su fecha y fuente original. Las
            novedades de cada proyecto se incorporan al mismo relato.
          </p>
        </div>
        <span className="blog-result-count">
          {visiblePosts.length}{" "}
          {visiblePosts.length === 1 ? "historia" : "historias"}
        </span>
      </div>
      <div className="blog-filters" aria-label="Filtrar el blog">
        {blogCategories.map((category) => (
          <button
            key={category}
            type="button"
            aria-pressed={activeCategory === category}
            onClick={() => setActiveCategory(category)}
          >
            {category}
          </button>
        ))}
      </div>
      <div className="blog-grid">
        {posts.map((post) => {
          const isVisible =
            activeCategory === "Todos" || post.category === activeCategory;

          return <BlogCard key={post.slug} post={post} hidden={!isVisible} />;
        })}
      </div>
    </>
  );
}
