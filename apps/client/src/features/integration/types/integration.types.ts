// Conqr Integration Layer — client types. The cross-product presentation
// contract now lives in the shared @conqr/integration-ui package (blueprint
// §7.1/§8.6); re-exported here so existing imports keep working.
import type { PresentationModel } from "@conqr/integration-ui";

export type {
  PresentationModel,
  ResolutionState,
  SmartObjectAction,
} from "@conqr/integration-ui";

export interface IntegrationRelationship {
  id: string;
  workspaceId: string;
  sourceUrn: string;
  sourceType: string;
  targetUrn: string;
  targetType: string;
  relationType: string;
  inverseRelationType: string;
  lifecycleState: string;
  provenance: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSpaceMapping {
  id: string;
  workspaceId: string;
  planeProjectId: string;
  spaceId: string;
  mappingKind: "primary" | "secondary";
  createdAt: string;
}

export interface ResolveRequest {
  urns: string[];
  planeProjectId?: string;
  displayMode?: string;
}

export interface CreateRelationshipRequest {
  sourceUrn: string;
  targetUrn: string;
  relationType: string;
  provenance?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Vertical Slice 01 — requirement to linked execution
// ---------------------------------------------------------------------------

/**
 * Coverage from the *viewer's* perspective.
 *
 * `all_restricted` is the honest third answer for someone who cannot see any
 * of the linked work: presenting it as covered would ask them to trust an
 * invisible item, and presenting it as uncovered could send them off to create
 * duplicate work. It renders as "Uncovered for you".
 */
export type CoverageState =
  | "uncovered"
  | "covered"
  | "provisional"
  | "all_restricted";

export interface DeliveryFreshness {
  urn: string;
  /** Where the answer came from, so the card can be labelled honestly. */
  origin: "live" | "projection" | "unavailable";
  stale: boolean;
  lastSyncedAt: string | null;
}

export interface RequirementCoverage {
  requirementId: string;
  blockId: string;
  urn: string;
  title: string | null;
  state: string;
  coverage: CoverageState;
  covered: boolean;
  linkedCount: number;
  relatedWork: PresentationModel[];
  delivery: DeliveryFreshness[];
}

export interface RequirementCoverageSummary {
  total: number;
  approvedOrBeyond: number;
  covered: number;
  uncovered: number;
  provisional: number;
  unresolvedSources: string[];
  gaps: Array<{
    requirementId: string;
    urn: string;
    title: string | null;
    state: string;
    coverage: CoverageState;
  }>;
}

export interface PageRequirementsResponse {
  items: RequirementCoverage[];
  summary: RequirementCoverageSummary;
}

export interface LinkedWorkPreview {
  requirementUrn: string;
  requirementTitle: string | null;
  planeProjectId: string;
  proposed: { title: string; descriptionHtml?: string; priority?: string };
  relationType: string;
  idempotencyKey: string;
  existingWork?: PresentationModel[];
}

export interface LinkedWorkReceipt {
  status: "created" | "already_exists" | "created_link_failed";
  requirementUrn: string;
  workItemUrn: string;
  workItemId: string;
  relationship: {
    relationType: string;
    inverseRelationType: string;
    id?: string;
  } | null;
  actor: { hubUserId: string };
  correlationId: string;
  idempotencyKey: string;
  warning?: string;
}
