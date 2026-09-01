/**
 * Task 7's Git TCB: every controller-facing Git invocation uses the fixed
 * system executable and a minimal environment.  In particular, neither the
 * executable lookup nor its child PATH can inherit an operator-controlled
 * value.
 */
export const fixedGitExecutable = "/usr/bin/git";

const fixedGitConfiguration = Object.freeze([
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
]);

const fixedGitEnvironment = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
});

/** Fixed Git arguments that disable repository-selected hooks and caches. */
export function fixedGitArgs(arguments_: readonly string[]): string[] {
  return [...fixedGitConfiguration, ...arguments_];
}

/**
 * Retained name for narrow callers. It deliberately returns only fixed values
 * instead of filtering and preserving the caller's ambient process env.
 */
export function sanitizedGitEnv(): NodeJS.ProcessEnv {
  return { ...fixedGitEnvironment };
}
