import { blogCategories, blogPosts as frozenBlogPosts } from "./blog-data";

import type { BlogCategory, BlogPost } from "./blog-data";

const repairedImages = new Map<string, string>([
  [
    "/media/historia-youtube-reqBqJBFQIk.jpg",
    "/media/historia-fuente-alamo-inauguracion.jpg",
  ],
]);

export { blogCategories };
export type { BlogCategory, BlogPost };

export const blogPosts: BlogPost[] = frozenBlogPosts.map((post) => {
  const repairedImage = repairedImages.get(post.image);
  return repairedImage === undefined ? post : { ...post, image: repairedImage };
});

export function getBlogPost(slug: string) {
  return blogPosts.find((post) => post.slug === slug);
}
