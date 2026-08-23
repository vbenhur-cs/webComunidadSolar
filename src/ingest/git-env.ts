/** Preserve normal process configuration while excluding Git's ambient overrides. */
export function sanitizedGitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.toUpperCase().startsWith("GIT_"),
    ),
  );
}
