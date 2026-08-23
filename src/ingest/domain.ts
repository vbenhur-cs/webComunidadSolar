export type CompositionMode = "auto" | "blocks" | "freeform" | "hybrid";

export type PrivateArea = "socios" | "equipo" | "manganafer";

export type ChangeState =
  | "received"
  | "normalized"
  | "planned"
  | "gate1_approved"
  | "generated"
  | "validated"
  | "gate2_approved"
  | "published"
  | "rejected"
  | "failed";

export type ResumeState =
  "received" | "normalized" | "planned" | "gate1_approved";

export interface ChangeRecord {
  schemaVersion: 1;
  changeId: string;
  state: ChangeState;
  revision: number;
  attemptNumber: number;
  currentAttemptId: string;
  resumeState: ResumeState;
  createdAt: string;
  updatedAt: string;
}

export interface TransitionEvent {
  type: string;
  to: ChangeState;
  payload: unknown;
}

export interface JournalEvent {
  sequence: number;
  at: string;
  type: string;
  from: ChangeState | null;
  to: ChangeState;
  payloadSha256: string;
  previousEventSha256: string | null;
  eventSha256: string;
}

export interface RequestAsset {
  path: string;
  sha256: string;
  mediaType: string;
}

export interface RequestInput {
  schemaVersion?: 1;
  changeId: string;
  intent: string;
  targetPath: `/${string}`;
  acceptanceCriteria: string[];
  audience?: string | null;
  mode?: CompositionMode;
  content?: string;
  claims?: string[];
  references?: string[];
  assets?: RequestAsset[];
  seo?: {
    title?: string | null;
    description?: string | null;
    index?: boolean;
  };
  privacy?: {
    private?: boolean;
    area?: PrivateArea | null;
  };
  allowedExternalLinks?: string[];
}

export interface NormalizedRequest {
  schemaVersion: 1;
  changeId: string;
  inputKind: "request" | "page";
  intent: string;
  audience: string | null;
  targetPath: `/${string}`;
  mode: CompositionMode;
  content: string;
  claims: string[];
  references: string[];
  assets: RequestAsset[];
  seo: {
    title: string | null;
    description: string | null;
    index: boolean;
  };
  privacy: { private: boolean; area: PrivateArea | null };
  allowedExternalLinks: string[];
  acceptanceCriteria: string[];
  inputSha256: string;
}

export interface ChangePlan {
  schemaVersion: 1;
  changeId: string;
  baselineCommit: string;
  requestSha256: string;
  selectedMode: Exclude<CompositionMode, "auto">;
  targetPath: `/${string}`;
  overwritesExistingRoute: boolean;
  files: Array<{ path: string; operation: "create" | "modify" }>;
  components: string[];
  islands: string[];
  dependencies: string[];
  validations: string[];
  publication: {
    adapter: "local" | "cloudflare";
    configSha256: string;
    environment: string | null;
    siteIndexable: boolean;
  };
  planSha256: string;
}

export interface ApprovalRecord {
  schemaVersion: 1;
  environment: "production" | "test";
  gate: 1 | 2;
  changeId: string;
  actor: string;
  approvedAt: string;
  subjectSha256: string;
  baselineCommit: string;
  candidateCommit: string | null;
  artifactSha256: string | null;
}

export interface ValidationResult {
  id: string;
  status: "passed" | "failed" | "skipped";
  evidence: string | null;
  evidenceSha256: string | null;
}

export interface AttemptRecord {
  schemaVersion: 1;
  changeId: string;
  attemptId: string;
  status: "running" | "generated" | "validated" | "rejected" | "failed";
  resumeState: "received" | "normalized" | "planned" | "gate1_approved" | null;
  adapter: string | null;
  startedAt: string;
  finishedAt: string | null;
  requestSha256: string | null;
  planSha256: string | null;
  baselineCommit: string;
  generatedFiles: string[];
  logs: {
    stdout: string | null;
    stderr: string | null;
    finalMessage: string | null;
  };
  validations: ValidationResult[];
  failure: { code: string; message: string } | null;
}

export interface CandidateManifest {
  schemaVersion: 1;
  changeId: string;
  attemptId: string;
  requestSha256: string;
  planSha256: string;
  baselineCommit: string;
  candidateCommit: string;
  artifactSha256: string;
  buildProfile: ChangePlan["publication"];
  routes: string[];
  files: string[];
  validations: Array<{
    id: string;
    status: "passed" | "failed";
    evidence: string;
  }>;
  artifacts: Array<{ path: string; sha256: string; bytes: number }>;
  preview: { command: string; url: string };
  knownDifferences: Array<{ description: string; approvalRequired: true }>;
}

const nextState: Partial<Record<ChangeState, ChangeState>> = {
  received: "normalized",
  normalized: "planned",
  planned: "gate1_approved",
  gate1_approved: "generated",
  generated: "validated",
  validated: "gate2_approved",
  gate2_approved: "published",
};

const terminalStates = new Set<ChangeState>([
  "published",
  "rejected",
  "failed",
]);

export function allowedTransition(from: ChangeState, to: ChangeState): boolean {
  if (nextState[from] === to) {
    return true;
  }

  return !terminalStates.has(from) && (to === "rejected" || to === "failed");
}
