/// <reference types="astro/client" />
/// <reference path="../worker-configuration.d.ts" />

declare module "*.sql?raw" {
  const source: string;
  export default source;
}
