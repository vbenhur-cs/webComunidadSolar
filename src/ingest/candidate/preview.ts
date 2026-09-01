/**
 * Task 10's public preview surface. The implementation remains beside the
 * private candidate record so no consumer can receive its bundle/config paths.
 */
export {
  createCandidatePreviewTestCapability,
  startCandidatePreview,
  type CandidatePreviewTestCapability,
  type FixedPreviewInvocation,
  type PreviewHandle,
} from "./manifest.ts";
