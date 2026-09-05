import { BadRequestException } from '@nestjs/common';
import { WorkItemCreationService } from './work-item-creation.service';

function make(overrides: {
  enabled?: boolean;
  createWorkItem?: jest.Mock;
  createRel?: jest.Mock;
}) {
  const plane = {
    isEnabled: () => overrides.enabled ?? true,
    createWorkItem:
      overrides.createWorkItem ??
      jest.fn().mockResolvedValue({ id: 'wi_new', name: 'x', updated_at: 't' }),
  };
  const relationships = {
    create: overrides.createRel ?? jest.fn().mockResolvedValue({ id: 'rel1' }),
  };
  // Delegation is minted per call; the jti doubles as the correlation id, so
  // the service must use it rather than generating its own.
  const delegatedTokens = {
    mintForPlane: jest.fn().mockReturnValue({
      token: 'obo.token.sig',
      jti: 'corr-from-token',
      personUid: 'conqr:person:user-1',
      orgUid: 'conqr:org:ws-1',
      scope: ['work-item:create'],
      expiresAt: 9_999_999,
    }),
  };
  return {
    service: new WorkItemCreationService(
      plane as any,
      relationships as any,
      delegatedTokens as any,
    ),
    plane,
    relationships,
    delegatedTokens,
  };
}

const input = {
  workspaceId: 'ws1',
  actorId: 'u1',
  sourceUrn: 'conqr://hub/page/p1#block=req_1',
  planeProjectId: 'proj1',
  title: 'Build SSO',
};

describe('WorkItemCreationService', () => {
  it('creates the item, links it with provenance, returns created', async () => {
    const { service, relationships } = make({});
    const res = await service.createFromHub(input);

    expect(res.status).toBe('created');
    expect(res.workItemUrn).toBe('conqr://plane/work-item/wi_new');
    const relArgs = relationships.create.mock.calls[0][0];
    expect(relArgs.provenance).toBe('hub.selection.create-work-item');
    expect(relArgs.metadata.target_project_id).toBe('proj1');
    expect(relArgs.targetUrn).toBe('conqr://plane/work-item/wi_new');
  });

  it('reports created_link_failed (never false success) when linking throws', async () => {
    const { service } = make({
      createRel: jest.fn().mockRejectedValue(new Error('db down')),
    });
    const res = await service.createFromHub(input);
    expect(res.status).toBe('created_link_failed');
    expect(res.workItem.id).toBe('wi_new');
    expect(res.warning).toBeTruthy();
  });

  it('rejects when integration is disabled', async () => {
    const { service } = make({ enabled: false });
    await expect(service.createFromHub(input)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a non-Hub source URN before touching Plane', async () => {
    const { service, plane } = make({});
    await expect(
      service.createFromHub({
        ...input,
        sourceUrn: 'conqr://plane/work-item/x',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(plane.createWorkItem).not.toHaveBeenCalled();
  });

  it('rejects a missing title before touching Plane', async () => {
    const { service, plane } = make({});
    await expect(
      service.createFromHub({ ...input, title: '  ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(plane.createWorkItem).not.toHaveBeenCalled();
  });

  describe('createManyFromHub (bulk §5.1B)', () => {
    const bulkInput = (rows: any[]) => ({
      workspaceId: 'ws1',
      actorId: 'u1',
      planeProjectId: 'proj1',
      rows,
    });

    it('reports per-row results with practical partial completion', async () => {
      // Row 2 (invalid title) fails; rows 1 and 3 succeed.
      const createWorkItem = jest
        .fn()
        .mockResolvedValue({ id: 'wi', name: 'x', updated_at: 't' });
      const { service } = make({ createWorkItem });
      const res = await service.createManyFromHub(
        bulkInput([
          { sourceUrn: 'conqr://hub/page/p1', title: 'A' },
          { sourceUrn: 'conqr://hub/page/p1', title: '   ' }, // invalid
          { sourceUrn: 'conqr://hub/page/p1', title: 'C' },
        ]),
      );
      expect(res.total).toBe(3);
      expect(res.created).toBe(2);
      expect(res.failed).toBe(1);
      expect(res.results[1]).toMatchObject({ index: 1, status: 'failed' });
      expect(res.results[0].status).toBe('created');
    });

    it('never fakes success when a row throws mid-batch', async () => {
      const createWorkItem = jest
        .fn()
        .mockResolvedValueOnce({ id: 'wi1', name: 'x' })
        .mockRejectedValueOnce(new Error('plane 500'))
        .mockResolvedValueOnce({ id: 'wi3', name: 'z' });
      const { service } = make({ createWorkItem });
      const res = await service.createManyFromHub(
        bulkInput([
          { sourceUrn: 'conqr://hub/page/p1', title: 'A' },
          { sourceUrn: 'conqr://hub/page/p1', title: 'B' },
          { sourceUrn: 'conqr://hub/page/p1', title: 'C' },
        ]),
      );
      expect(res.created).toBe(2);
      expect(res.failed).toBe(1);
      expect(res.results[1].error).toContain('plane 500');
    });

    it('rejects an empty batch', async () => {
      const { service } = make({});
      await expect(service.createManyFromHub(bulkInput([]))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
