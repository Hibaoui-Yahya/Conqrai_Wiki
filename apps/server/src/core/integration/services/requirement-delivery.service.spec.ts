// SmartObjectResolverService reaches PageRepo, which pulls the ESM editor
// stack into Jest's CommonJS transform. The service is injected as a fake
// here anyway, so the module is stubbed following the pattern used by the
// other tool specs in this repo.
jest.mock('./smart-object-resolver.service', () => ({
  SmartObjectResolverService: class {},
}));
// ProjectSpaceMappingService reaches PageService, which pulls the ESM editor
// stack into Jest's CommonJS transform.
jest.mock('./project-space-mapping.service', () => ({
  ProjectSpaceMappingService: class {},
}));

import { RequirementDeliveryService } from './requirement-delivery.service';
import { RelationType } from '../domain/relationship-types';
import { ResolutionState } from '../domain/presentation.types';
import { CoverageState } from '../domain/requirement-coverage';
import { PlaneApiError } from './plane-client.service';
import { WorkItemCreationService } from './work-item-creation.service';

/**
 * Vertical Slice 01 acceptance tests.
 *
 * These exercise the real WorkItemCreationService against a faked ConqrPlan
 * transport, so the idempotency and partial-failure behaviour under test is
 * the production code path rather than a mock of it. Delegation itself is
 * proven separately (delegated-token.util.spec.ts and ConqrPlan's
 * test_delegation.py); here it is asserted only that a delegation travels.
 */

const WORKSPACE = 'ws-1';
const ACTOR = 'user-1';
const PAGE = 'page-1';
const BLOCK = 'req-block-1';
const PROJECT = 'proj-1';
const REQ_URN = `conqr://hub/page/${PAGE}#block=${BLOCK}`;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A ConqrPlan that enforces (external_id, external_source) uniqueness. */
function makePlane() {
  const items = new Map<string, any>();
  const byExternalId = new Map<string, string>();
  let counter = 0;

  return {
    items,
    byExternalId,
    isEnabled: jest.fn().mockReturnValue(true),
    createWorkItem: jest.fn(async (_projectId: string, body: any) => {
      if (body.external_id) {
        const existing = byExternalId.get(body.external_id);
        if (existing) {
          // ConqrPlan's real response: 409 carrying the existing id.
          throw new PlaneApiError('conflict', 409, false, {
            error: 'Issue with the same external id and external source already exists',
            id: existing,
          });
        }
      }
      const id = `wi-${++counter}`;
      const item = {
        id,
        name: body.name,
        project: PROJECT,
        sequence_id: counter,
        updated_at: '2026-09-04T10:00:00Z',
        assignees: [],
        labels: [],
      };
      items.set(id, item);
      if (body.external_id) byExternalId.set(body.external_id, id);
      return item;
    }),
    getWorkItem: jest.fn(async (_projectId: string, id: string) => {
      const item = items.get(id);
      if (!item) throw new PlaneApiError('not found', 404, false);
      return item;
    }),
  } as any;
}

/** An in-memory Context Graph with the real insert-if-absent semantics. */
function makeRelationships() {
  const edges: any[] = [];
  return {
    edges,
    create: jest.fn(async (input: any) => {
      const found = edges.find(
        (e) =>
          e.workspaceId === input.workspaceId &&
          e.sourceUrn === input.sourceUrn &&
          e.targetUrn === input.targetUrn &&
          e.relationType === input.relationType,
      );
      if (found) return found;
      const row = {
        id: `rel-${edges.length + 1}`,
        inverseRelationType:
          input.relationType === RelationType.ImplementedBy
            ? RelationType.Implements
            : null,
        ...input,
      };
      edges.push(row);
      return row;
    }),
    listForUrn: jest.fn(async (workspaceId: string, urn: string) =>
      edges.filter(
        (e) =>
          e.workspaceId === workspaceId &&
          (e.sourceUrn === urn || e.targetUrn === urn),
      ),
    ),
  } as any;
}

function makeService(over: Record<string, any> = {}) {
  const plane = over.plane ?? makePlane();
  const relationships = over.relationships ?? makeRelationships();
  const delegation = {
    mintForPlane: jest.fn().mockReturnValue({
      token: 'obo-token',
      jti: 'corr-1',
      personUid: 'conqr:person:user-1',
      orgUid: 'conqr:org:ws-1',
      scope: ['work-item:create'],
      expiresAt: 9_999_999,
    }),
  };
  const creation =
    over.creation ??
    new WorkItemCreationService(plane, relationships, delegation as any);

  const requirements = over.requirements ?? {
    listForPage: jest.fn().mockResolvedValue([
      { id: 'req-1', pageId: PAGE, blockId: BLOCK, title: 'Users can log in', state: 'approved' },
    ]),
    findById: jest.fn().mockResolvedValue({
      id: 'req-1',
      pageId: PAGE,
      blockId: BLOCK,
      title: 'Users can log in',
      state: 'approved',
    }),
  };

  const resolver = over.resolver ?? {
    resolveMany: jest.fn(async (urns: string[]) =>
      urns.map((urn) => ({
        urn,
        state: ResolutionState.Live,
        title: 'Implement login',
        fields: { state: 'In Progress', stateGroup: 'started' },
      })),
    ),
  };

  const mappings = over.mappings ?? {
    resolveSpacePlaneTarget: jest.fn().mockResolvedValue({ planeProjectId: PROJECT }),
  };
  const pages = over.pages ?? {
    findById: jest.fn().mockResolvedValue({
      id: PAGE,
      workspaceId: WORKSPACE,
      spaceId: 'space-1',
    }),
  };

  // The read path in front of the resolver: projection first, live fallback,
  // read repair. Its own behaviour is covered by delivery-read.service.spec.ts
  // and the database-backed projection tests; here it is a thin pass-through so
  // these tests stay about coverage and linking.
  const deliveryRead = over.deliveryRead ?? {
    resolveMany: jest.fn(async (urns: string[], ctx: any) => {
      const models = await resolver.resolveMany(urns, ctx);
      return models.map((model: any) => ({
        urn: model.urn,
        model,
        origin: 'live' as const,
        stale: false,
        lastSyncedAt: '2026-09-04T10:00:00.000Z',
      }));
    }),
  };

  const service = new RequirementDeliveryService(
    requirements as any,
    relationships,
    resolver as any,
    deliveryRead as any,
    creation,
    mappings as any,
    pages as any,
  );
  return { service, plane, relationships, resolver, deliveryRead, delegation, creation, requirements };
}

const createArgs = {
  workspaceId: WORKSPACE,
  actorId: ACTOR,
  requirementId: 'req-1',
};

// ===========================================================================
// 1-4. Create one linked work item, under the real user, canonically linked
// ===========================================================================

describe('creating linked work', () => {
  it('creates one work item and records exactly one canonical relationship', async () => {
    const { service, plane, relationships } = makeService();

    const receipt = await service.createLinkedWork(createArgs);

    expect(receipt.status).toBe('created');
    expect(plane.createWorkItem).toHaveBeenCalledTimes(1);
    expect(relationships.edges).toHaveLength(1);

    const edge = relationships.edges[0];
    // Stored once, from the Hub requirement. The inverse is derived, not a
    // second row, and ConqrPlan holds no copy of it at all.
    expect(edge.sourceUrn).toBe(REQ_URN);
    expect(edge.targetUrn).toBe(receipt.workItemUrn);
    expect(edge.relationType).toBe(RelationType.ImplementedBy);
    expect(receipt.relationship).toMatchObject({
      relationType: RelationType.ImplementedBy,
      inverseRelationType: RelationType.Implements,
    });
  });

  it('returns valid canonical URNs for both objects', async () => {
    const { service } = makeService();
    const receipt = await service.createLinkedWork(createArgs);

    expect(receipt.requirementUrn).toBe(REQ_URN);
    expect(receipt.workItemUrn).toMatch(/^conqr:\/\/plane\/work-item\/wi-\d+$/);
  });

  it('returns a receipt naming the actor and correlation id', async () => {
    const { service } = makeService();
    const receipt = await service.createLinkedWork(createArgs);

    expect(receipt.actor).toEqual({ hubUserId: ACTOR });
    expect(receipt.correlationId).toBe('corr-1');
    expect(receipt.idempotencyKey).toContain(REQ_URN);
    expect(receipt.idempotencyKey).toContain(PROJECT);
  });

  it('writes under the acting user, not the integration credential', async () => {
    const { service, plane, delegation } = makeService();
    await service.createLinkedWork(createArgs);

    expect(delegation.mintForPlane).toHaveBeenCalledWith(
      expect.objectContaining({ hubUserId: ACTOR, hubWorkspaceId: WORKSPACE }),
    );
    // The delegation travels with the ConqrPlan call.
    const [, , callContext] = plane.createWorkItem.mock.calls[0];
    expect(callContext).toMatchObject({ delegation: 'obo-token' });
  });
});

// ===========================================================================
// 5. Retrying creates no duplicates
// ===========================================================================

describe('retry safety', () => {
  it('a repeated confirm creates no second work item and no second relationship', async () => {
    const { service, plane, relationships } = makeService();

    const first = await service.createLinkedWork(createArgs);
    const second = await service.createLinkedWork(createArgs);

    expect(first.status).toBe('created');
    expect(second.status).toBe('already_exists');
    expect(second.workItemUrn).toBe(first.workItemUrn);
    // Two attempts, one item, one edge.
    expect(plane.items.size).toBe(1);
    expect(relationships.edges).toHaveLength(1);
  });

  it('uses the same idempotency key for the same requirement and project', async () => {
    const a = RequirementDeliveryService.idempotencyKey(REQ_URN, PROJECT);
    const b = RequirementDeliveryService.idempotencyKey(REQ_URN, PROJECT);
    const other = RequirementDeliveryService.idempotencyKey(REQ_URN, 'proj-2');

    expect(a).toBe(b);
    // Scoped by project: the same requirement may legitimately have work in
    // two projects.
    expect(a).not.toBe(other);
  });
});

// ===========================================================================
// 6. The requirement becomes covered
// ===========================================================================

describe('coverage', () => {
  it('is uncovered before, covered after', async () => {
    const { service } = makeService();

    const before = await service.pageRequirements({
      workspaceId: WORKSPACE,
      viewerId: ACTOR,
      pageId: PAGE,
    });
    expect(before.items[0].coverage).toBe(CoverageState.Uncovered);
    expect(before.items[0].covered).toBe(false);
    expect(before.items[0].relatedWork).toEqual([]);
    expect(before.summary).toMatchObject({ total: 1, covered: 0, uncovered: 1 });

    await service.createLinkedWork(createArgs);

    const after = await service.pageRequirements({
      workspaceId: WORKSPACE,
      viewerId: ACTOR,
      pageId: PAGE,
    });
    expect(after.items[0].coverage).toBe(CoverageState.Covered);
    expect(after.items[0].covered).toBe(true);
    expect(after.items[0].relatedWork).toHaveLength(1);
    expect(after.summary).toMatchObject({ total: 1, covered: 1, uncovered: 0 });
  });

  it('surfaces the live ConqrPlan status through the resolver', async () => {
    const { service } = makeService();
    await service.createLinkedWork(createArgs);

    const { items: reqs } = await service.pageRequirements({
      workspaceId: WORKSPACE,
      viewerId: ACTOR,
      pageId: PAGE,
    });
    const req = reqs[0];

    expect(req.relatedWork[0]).toMatchObject({
      state: ResolutionState.Live,
      fields: { state: 'In Progress' },
    });
  });
});

// ===========================================================================
// 11. Permission-shaped presentation
// ===========================================================================

describe('permission-shaped related work', () => {
  const RESTRICTED_KEYS = ['title', 'fields', 'deepLink'];

  it('reveals nothing about work the viewer may not see', async () => {
    const restrictedResolver = {
      resolveMany: jest.fn(async (urns: string[]) =>
        urns.map((urn) => ({ urn, state: ResolutionState.Restricted })),
      ),
    };
    const { service } = makeService({ resolver: restrictedResolver });
    await service.createLinkedWork(createArgs);

    const { items: reqs } = await service.pageRequirements({
      workspaceId: WORKSPACE,
      viewerId: 'viewer-without-access',
      pageId: PAGE,
    });
    const req = reqs[0];

    const card = req.relatedWork[0] as unknown as Record<string, unknown>;
    expect(card.state).toBe(ResolutionState.Restricted);
    // No title, no project, no assignee, no status, no link.
    for (const key of RESTRICTED_KEYS) {
      expect(card[key]).toBeUndefined();
    }
    expect(JSON.stringify(card)).not.toContain('Implement login');
  });

  it('resolves work as the viewer, not as the requester of the page', async () => {
    const resolver = {
      resolveMany: jest.fn(async (urns: string[]) =>
        urns.map((urn) => ({ urn, state: ResolutionState.Restricted })),
      ),
    };
    const { service } = makeService({ resolver });
    await service.createLinkedWork(createArgs);

    await service.pageRequirements({
      workspaceId: WORKSPACE,
      viewerId: 'viewer-9',
      pageId: PAGE,
    });

    expect(resolver.resolveMany).toHaveBeenLastCalledWith(
      expect.any(Array),
      expect.objectContaining({ viewerId: 'viewer-9' }),
    );
  });

  it('reports "uncovered for you" when every link is restricted', async () => {
    const resolver = {
      resolveMany: jest.fn(async (urns: string[]) =>
        urns.map((urn) => ({ urn, state: ResolutionState.Restricted })),
      ),
    };
    const { service } = makeService({ resolver });
    await service.createLinkedWork(createArgs);

    const { items: reqs } = await service.pageRequirements({
      workspaceId: WORKSPACE,
      viewerId: 'viewer-without-access',
      pageId: PAGE,
    });
    const req = reqs[0];

    // Neither "covered" nor plainly "uncovered". A viewer who cannot see the
    // linked work cannot verify that it covers anything, so presenting it as
    // covered would ask them to trust an invisible item; presenting it as
    // uncovered could send them off to create duplicate work. `all_restricted`
    // says exactly what is true and renders as "Uncovered for you".
    expect(req.coverage).toBe(CoverageState.AllRestricted);
    expect(req.covered).toBe(false);
  });

  it('leaks no identifying metadata in the all_restricted case', async () => {
    const resolver = {
      resolveMany: jest.fn(async (urns: string[]) =>
        urns.map((urn) => ({ urn, state: ResolutionState.Restricted })),
      ),
    };
    const { service } = makeService({ resolver });
    await service.createLinkedWork(createArgs);

    const result = await service.pageRequirements({
      workspaceId: WORKSPACE,
      viewerId: 'viewer-without-access',
      pageId: PAGE,
    });

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('Implement login');
    expect(serialised).not.toContain(PROJECT);
    // Restricted URNs are never listed as unresolved sources: naming them
    // would confirm which items exist.
    expect(result.summary.unresolvedSources).toEqual([]);
  });
});

// ===========================================================================
// 13. ConqrPlan success + Hub link failure is recoverable, visible, auditable
// ===========================================================================

describe('partial failure across the product boundary', () => {
  it('reports created_link_failed rather than success', async () => {
    const relationships = makeRelationships();
    relationships.create = jest.fn().mockRejectedValue(new Error('graph write failed'));
    const { service, plane } = makeService({ relationships });

    const receipt = await service.createLinkedWork(createArgs);

    expect(receipt.status).toBe('created_link_failed');
    // The item really does exist in ConqrPlan; saying otherwise would be worse.
    expect(plane.items.size).toBe(1);
    expect(receipt.workItemUrn).toBeDefined();
    expect(receipt.warning).toMatch(/same idempotency key/i);
    expect(receipt.relationship).toBeNull();
  });

  it('recovers on retry: re-finds the item and only creates the link', async () => {
    const relationships = makeRelationships();
    const realCreate = relationships.create;
    relationships.create = jest.fn().mockRejectedValueOnce(new Error('graph write failed'));
    const { service, plane } = makeService({ relationships });

    const failed = await service.createLinkedWork(createArgs);
    expect(failed.status).toBe('created_link_failed');

    // Graph recovers; the user retries the same action.
    relationships.create = realCreate;
    const retried = await service.createLinkedWork(createArgs);

    expect(retried.status).toBe('already_exists');
    expect(retried.workItemUrn).toBe(failed.workItemUrn);
    // Still exactly one work item and one relationship.
    expect(plane.items.size).toBe(1);
    expect(relationships.edges).toHaveLength(1);
  });
});

// ===========================================================================
// 14. Losing a relationship never deletes ConqrPlan work
// ===========================================================================

describe('relationship removal', () => {
  it('leaves the ConqrPlan work item untouched', async () => {
    const { service, plane, relationships } = makeService();
    const receipt = await service.createLinkedWork(createArgs);

    // Drop the edge, as removing a link from the Related Work panel would.
    relationships.edges.length = 0;

    const { items: reqs } = await service.pageRequirements({
      workspaceId: WORKSPACE,
      viewerId: ACTOR,
      pageId: PAGE,
    });
    const req = reqs[0];

    expect(req.covered).toBe(false);
    // The work still exists. ConqrHub owns the relationship, never the work.
    expect(plane.items.has(receipt.workItemId)).toBe(true);
  });
});

// ===========================================================================
// Preview
// ===========================================================================

describe('preview', () => {
  it('describes the mutation without performing it', async () => {
    const { service, plane, relationships } = makeService();

    const preview = await service.previewLinkedWork({
      workspaceId: WORKSPACE,
      viewerId: ACTOR,
      requirementId: 'req-1',
    });

    expect(preview.requirementUrn).toBe(REQ_URN);
    expect(preview.planeProjectId).toBe(PROJECT);
    expect(preview.proposed.title).toBe('Users can log in');
    expect(preview.relationType).toBe(RelationType.ImplementedBy);
    // Nothing happened.
    expect(plane.createWorkItem).not.toHaveBeenCalled();
    expect(relationships.edges).toHaveLength(0);
  });

  it('shows existing work so the user is not led into a duplicate', async () => {
    const { service } = makeService();
    await service.createLinkedWork(createArgs);

    const preview = await service.previewLinkedWork({
      workspaceId: WORKSPACE,
      viewerId: ACTOR,
      requirementId: 'req-1',
    });

    expect(preview.existingWork).toHaveLength(1);
  });

  it('refuses when the page has no mapped ConqrPlan project', async () => {
    const { service } = makeService({
      mappings: { resolveSpacePlaneTarget: jest.fn().mockResolvedValue({}) },
    });

    await expect(
      service.previewLinkedWork({
        workspaceId: WORKSPACE,
        viewerId: ACTOR,
        requirementId: 'req-1',
      }),
    ).rejects.toThrow(/no mapped ConqrPlan project/i);
  });
});
