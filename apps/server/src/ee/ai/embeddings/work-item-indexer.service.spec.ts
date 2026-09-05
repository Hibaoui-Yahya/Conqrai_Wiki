
/** Delegation stub: reads must carry a signed on-behalf-of token. */
function makeDelegation() {
  return {
    mintForPlane: jest.fn().mockImplementation(({ scope }: { scope: string[] }) => ({
      token: 'obo-token',
      jti: 'corr-1',
      personUid: 'conqr:person:user-1',
      orgUid: 'conqr:org:ws-1',
      scope,
      expiresAt: 9_999_999,
    })),
    mintCallContext: jest.fn().mockReturnValue({
      delegation: 'obo-token',
      correlationId: 'corr-1',
    }),
  } as any;
}

import { WorkItemIndexerService } from './work-item-indexer.service';
import { PlaneApiError } from '../../../core/integration/services/plane-client.service';

function makeDeps(overrides: Partial<Record<string, any>> = {}) {
  const plane = {
    isEnabled: jest.fn().mockReturnValue(true),
    getWorkItem: jest.fn().mockResolvedValue({
      id: 'wi-1',
      name: 'Login fails on Safari',
      description_stripped: 'Steps to reproduce...',
      sequence_id: 42,
      state_detail: { name: 'Backlog', group: 'backlog' },
      labels: ['l1'],
      project: 'proj-1',
    }),
    listLabels: jest
      .fn()
      .mockResolvedValue([{ id: 'l1', name: 'bug' }, { id: 'l2', name: 'story' }]),
    listWorkItemsPage: jest.fn(),
    ...overrides.plane,
  };
  const mappings = {
    findPrimaryForProjectAnyWorkspace: jest.fn().mockResolvedValue({
      id: 'm1',
      workspaceId: 'ws-1',
      spaceId: 'sp-1',
      planeProjectId: 'proj-1',
      mappingKind: 'primary',
      createdBy: 'user-1',
    }),
    ...overrides.mappings,
  };
  const aiProvider = {
    isAvailable: jest.fn().mockReturnValue(true),
    embedMany: jest.fn().mockResolvedValue([[0.1, 0.2]]),
    getEmbeddingDimension: jest.fn().mockReturnValue(1024),
    ...overrides.aiProvider,
  };
  const env = {
    getAiEmbeddingModel: jest.fn().mockReturnValue('mistral-embed'),
    getAiEmbeddingChunkChars: jest.fn().mockReturnValue(2000),
    getAiEmbeddingChunkOverlap: jest.fn().mockReturnValue(200),
    getAiEmbeddingBatchSize: jest.fn().mockReturnValue(16),
    getPlaneAppUrl: jest.fn().mockReturnValue('http://plane.test'),
    getPlaneWorkspaceSlug: jest.fn().mockReturnValue('conqr'),
    ...overrides.env,
  };
  const chunking = {
    contentHash: jest.fn().mockReturnValue('hash-1'),
    chunk: jest
      .fn()
      .mockReturnValue([{ chunkIndex: 0, chunkText: 'Login fails on Safari Steps to reproduce...' }]),
    ...overrides.chunking,
  };
  const repo = {
    isContentUnchanged: jest.fn().mockResolvedValue(false),
    upsertChunks: jest.fn().mockResolvedValue(undefined),
    deleteBySource: jest.fn().mockResolvedValue(undefined),
    ...overrides.repo,
  };
  const delegation = makeDelegation();
  const svc = new WorkItemIndexerService(
    plane as any,
    mappings as any,
    aiProvider as any,
    env as any,
    chunking as any,
    repo as any,
    delegation,
  );
  return { svc, plane, mappings, aiProvider, env, chunking, repo, delegation };
}

describe('WorkItemIndexerService', () => {
  it('indexes a mapped work item under the mapped space with label names in metadata', async () => {
    const { svc, repo } = makeDeps();

    const res = await svc.indexWorkItem('wi-1', 'proj-1');

    expect(res.status).toBe('indexed');
    expect(repo.upsertChunks).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        spaceId: 'sp-1',
        sourceKind: 'plane_work_item',
        sourceId: 'wi-1',
        chunks: [
          expect.objectContaining({
            metadata: expect.objectContaining({
              workItemId: 'wi-1',
              projectId: 'proj-1',
              title: 'Login fails on Safari',
              sequenceId: 42,
              state: 'Backlog',
              labels: ['bug'],
              url: 'http://plane.test/conqr/projects/proj-1/issues/wi-1',
            }),
          }),
        ],
      }),
    );
  });

  it('returns unmapped (and does not index) when the project has no space mapping', async () => {
    const { svc, repo } = makeDeps({
      mappings: {
        findPrimaryForProjectAnyWorkspace: jest.fn().mockResolvedValue(undefined),
      },
    });
    const res = await svc.indexWorkItem('wi-1', 'proj-1');
    expect(res.status).toBe('unmapped');
    expect(repo.upsertChunks).not.toHaveBeenCalled();
  });

  it('reads ConqrPlan as the person who created the mapping', async () => {
    const { svc, plane, delegation } = makeDeps();

    await svc.indexWorkItem('wi-1', 'proj-1');

    expect(delegation.mintCallContext).toHaveBeenCalledWith('user-1', 'ws-1', [
      'work-item:read',
    ]);
    expect(plane.getWorkItem).toHaveBeenCalledWith('proj-1', 'wi-1', {
      delegation: 'obo-token',
      correlationId: 'corr-1',
    });
  });

  it('skips a mapping with no recorded creator rather than reading as the bridge credential', async () => {
    const { svc, plane, repo } = makeDeps({
      mappings: {
        findPrimaryForProjectAnyWorkspace: jest.fn().mockResolvedValue({
          id: 'm1',
          workspaceId: 'ws-1',
          spaceId: 'sp-1',
          planeProjectId: 'proj-1',
          mappingKind: 'primary',
          createdBy: null,
        }),
      },
    });

    const res = await svc.indexWorkItem('wi-1', 'proj-1');

    expect(res.status).toBe('no_actor');
    expect(plane.getWorkItem).not.toHaveBeenCalled();
    expect(repo.upsertChunks).not.toHaveBeenCalled();
  });

  it('returns ai_unavailable when no embedding provider is configured', async () => {
    const { svc } = makeDeps({
      aiProvider: { isAvailable: jest.fn().mockReturnValue(false) },
    });
    const res = await svc.indexWorkItem('wi-1', 'proj-1');
    expect(res.status).toBe('ai_unavailable');
  });

  it('deletes embeddings and reports deleted when Plane returns 404', async () => {
    const { svc, repo } = makeDeps({
      plane: {
        getWorkItem: jest
          .fn()
          .mockRejectedValue(new PlaneApiError('Not found', 404, false)),
      },
    });
    const res = await svc.indexWorkItem('wi-1', 'proj-1');
    expect(res.status).toBe('deleted');
    expect(repo.deleteBySource).toHaveBeenCalledWith('plane_work_item', 'wi-1');
  });

  it('skips when content hash is unchanged', async () => {
    const { svc, repo } = makeDeps({
      repo: { isContentUnchanged: jest.fn().mockResolvedValue(true) },
    });
    const res = await svc.indexWorkItem('wi-1', 'proj-1');
    expect(res.status).toBe('skipped');
    expect(repo.upsertChunks).not.toHaveBeenCalled();
  });

  it('treats archived work items as deletions', async () => {
    const { svc, repo } = makeDeps({
      plane: {
        getWorkItem: jest.fn().mockResolvedValue({
          id: 'wi-1',
          name: 'Old',
          archived_at: '2026-01-01T00:00:00Z',
          project: 'proj-1',
        }),
      },
    });
    const res = await svc.indexWorkItem('wi-1', 'proj-1');
    expect(res.status).toBe('deleted');
    expect(repo.deleteBySource).toHaveBeenCalledWith('plane_work_item', 'wi-1');
  });

  it('backfills a project across cursor pages, counting failures', async () => {
    const { svc, plane } = makeDeps();
    plane.listWorkItemsPage
      .mockResolvedValueOnce({
        results: [{ id: 'wi-1' }, { id: 'wi-2' }],
        nextCursor: '100:1:0',
      })
      .mockResolvedValueOnce({
        results: [{ id: 'wi-3' }],
        nextCursor: null,
      });
    const indexSpy = jest
      .spyOn(svc, 'indexWorkItem')
      .mockResolvedValueOnce({ workItemId: 'wi-1', status: 'indexed' })
      .mockResolvedValueOnce({ workItemId: 'wi-2', status: 'skipped' })
      .mockRejectedValueOnce(new Error('boom'));

    const res = await svc.backfillProject('proj-1');

    expect(indexSpy).toHaveBeenCalledTimes(3);
    expect(res).toEqual({ indexed: 1, skipped: 1, failed: 1 });
  });
});
