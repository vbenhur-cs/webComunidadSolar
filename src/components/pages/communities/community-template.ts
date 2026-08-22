import {
  communityPages,
  type Community,
} from "../../../content/community-data.ts";

export type CommunityTemplate = "local" | "network";
export type CommunityCoverageDto = Pick<
  Community,
  | "slug"
  | "name"
  | "province"
  | "status"
  | "summary"
  | "map"
  | "commercialStatus"
>;

export const communityDetailStaticPaths = communityPages.map((community) => ({
  params: { community: community.slug },
  props: { community },
}));

export function selectCommunityTemplate(
  community: Community,
): CommunityTemplate {
  return community.kind === "network" ? "network" : "local";
}

export function communityCoverageDto(
  community: Community,
): CommunityCoverageDto {
  return {
    slug: community.slug,
    name: community.name,
    province: community.province,
    status: community.status,
    summary: community.summary,
    map: community.map,
    commercialStatus: community.commercialStatus,
  };
}
