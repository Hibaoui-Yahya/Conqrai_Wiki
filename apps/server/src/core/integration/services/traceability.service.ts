import { Injectable } from '@nestjs/common';
import { RelationshipRepo } from '@docmost/db/repos/integration/relationship.repo';
import { SmartObjectResolverService } from './smart-object-resolver.service';
import { parseUrn, isPlaneUrn } from '../domain/urn.util';
import { RelationType } from '../domain/relationship-types';
import { ResolutionState } from '../domain/presentation.types';

export interface CoverageItem {
  urn: string;
  title?: string;
  state?: string;
  completed: boolean;
  resolutionState: ResolutionState;
}

export interface PageCoverage {
  sourceUrn: string;
  totalLinkedWork: number;
  completed: number;
  /** 0–1; null when there is no linked work to measure. */
  coverage: number | null;
  hasDeliveryWork: boolean;
  items: CoverageItem[];
}

// Relations that mean "this Hub object is delivered/implemented by that work".
const DELIVERY_RELATIONS = new Set<string>([
  RelationType.ImplementedBy,
  RelationType.SpecifiedBy,
  RelationType.OperationalizedBy,
  RelationType.TestedBy,
  RelationType.EvidencedBy,
]);

/**
 * Requirement coverage & traceability (blueprint §6.2). Computes how much of a
 * Hub object's delivery work is complete, using the typed edge store plus live
 * resolution of each work item — answering questions plain links cannot.
 *
 * Scoped to what's computable today: full "approved requirements with no work"
 * needs the requirement-block lifecycle (§6.2), which is not yet built.
 */

/**
 * Map each Plane work-item URN to the project recorded on its relationship.
 *
 * The project is written as `metadata.target_project_id` when the link is
 * created, and it is the only place the project survives - the URN
 * deliberately does not carry it, so a work item that moves project keeps its
 * identity.
 *
 * It is read back under *both* spellings on purpose. Kysely's
 * `CamelCasePlugin` maps column names, but it also recurses into plain object
 * values, so a `jsonb` column written as `{target_project_id: ...}` arrives in
 * application code as `{targetProjectId: ...}`. Reading only the name it was
 * written under found nothing, and the caller then fell back to "no project",
 * which is indistinguishable from ConqrPlan being unreachable. Accepting both
 * also means rows written before or after any plugin change keep working.
 */
export function projectByUrnFromEdges(
  edges: { sourceUrn: string; targetUrn: string; metadata?: unknown }[],
): Record<string, string> {
  const byUrn: Record<string, string> = {};
  for (const edge of edges) {
    const metadata = edge.metadata as {
      target_project_id?: unknown;
      targetProjectId?: unknown;
    } | null;
    const projectId = metadata?.targetProjectId ?? metadata?.target_project_id;
    if (typeof projectId !== 'string' || !projectId) continue;
    for (const urn of [edge.sourceUrn, edge.targetUrn]) {
      if (urn.startsWith('conqr://plane/work-item/')) byUrn[urn] = projectId;
    }
  }
  return byUrn;
}

@Injectable()
export class TraceabilityService {
  constructor(
    private readonly relationships: RelationshipRepo,
    private readonly resolver: SmartObjectResolverService,
  ) {}

  async pageCoverage(
    workspaceId: string,
    sourceUrn: string,
    viewerId: string,
    planeProjectId?: string,
  ): Promise<PageCoverage> {
    parseUrn(sourceUrn); // throws on malformed

    const edges = await this.relationships.findForUrn(workspaceId, sourceUrn);

    // Work items this object is delivered by (source side of a delivery relation),
    // or that implement it (target side pointing back).
    const workUrns = new Set<string>();
    for (const e of edges) {
      if (e.sourceUrn === sourceUrn && DELIVERY_RELATIONS.has(e.relationType)) {
        if (isPlaneUrn(e.targetUrn)) workUrns.add(e.targetUrn);
      } else if (
        e.targetUrn === sourceUrn &&
        DELIVERY_RELATIONS.has(e.inverseRelationType)
      ) {
        if (isPlaneUrn(e.sourceUrn)) workUrns.add(e.sourceUrn);
      }
    }

    const urns = Array.from(workUrns);
    // Each edge records the project its work item lives in. Use it: the page's
    // own space may map to a different project, or to none at all, and without
    // a project the item cannot be looked up and reports a generic failure
    // instead of its real state.
    const planeProjectByUrn = projectByUrnFromEdges(edges);
    const models = await this.resolver.resolveMany(urns, {
      workspaceId,
      viewerId,
      planeProjectId,
      planeProjectByUrn,
    });

    const items: CoverageItem[] = models.map((m) => ({
      urn: m.urn,
      title: m.title,
      state: (m.fields?.['state'] as string) ?? undefined,
      completed: Boolean(m.fields?.['completed']),
      resolutionState: m.state,
    }));

    const total = items.length;
    const completed = items.filter((i) => i.completed).length;
    return {
      sourceUrn,
      totalLinkedWork: total,
      completed,
      coverage: total === 0 ? null : completed / total,
      hasDeliveryWork: total > 0,
      items,
    };
  }
}
