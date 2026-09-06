import { WorkIntelService } from './work-intel.service';

function chunk(
  sourceId: string,
  score: number,
  meta: Partial<Record<string, unknown>> = {},
) {
  return {
    sourceKind: 'plane_work_item' as const,
    sourceId,
    chunkIndex: 0,
    chunkText: 'text',
    score,
    metadata: {
      workItemId: sourceId,
      projectId: 'proj-1',
      title: `Item ${sourceId}`,
      sequenceId: 1,
      state: 'Backlog',
      labels: ['bug'],
      url: `http://plane.test/conqr/projects/proj-1/issues/${sourceId}`,
      ...meta,
    },
  };
}

function makeSvc(results: any[], overrides: Partial<Record<string, any>> = {}) {
  const aiProvider = {
    isAvailable: jest.fn().mockReturnValue(true),
    embedMany: jest.fn().mockResolvedValue([[0.1, 0.2]]),
    ...overrides.aiProvider,
  };
  const repo = {
    similaritySearch: jest.fn().mockResolvedValue(results),
    ...overrides.repo,
  };
  const spaceMemberRepo = {
    getUserSpaceIds: jest.fn().mockResolvedValue(['space-1']),
    ...overrides.spaceMemberRepo,
  };
  // Retrieval is authorised against ConqrPlan, not just Hub space membership,
  // so the default fixture is a viewer ConqrPlan will show 'proj-1' to.
  const plane = {
    isEnabled: jest.fn().mockReturnValue(true),
    listProjects: jest.fn().mockResolvedValue([{ id: 'proj-1', name: 'Proj' }]),
    ...overrides.plane,
  };
  const delegation = {
    mintCallContext: jest
      .fn()
      .mockReturnValue({ delegation: 'obo-token', correlationId: 'corr-1' }),
    ...overrides.delegation,
  };
  const svc = new WorkIntelService(
    aiProvider as any,
    repo as any,
    spaceMemberRepo as any,
    plane as any,
    delegation as any,
  );
  return { svc, aiProvider, repo, spaceMemberRepo, plane, delegation };
}

describe('WorkIntelService', () => {
  it('groups chunks by work item, keeping the best score, capped at limit', async () => {
    const { svc } = makeSvc([
      chunk('a', 0.9),
      chunk('a', 0.7),
      chunk('b', 0.8),
      chunk('c', 0.5),
    ]);
    const items = await svc.findSimilar({
      workspaceId: 'ws-1',
      userId: 'user-1',
      title: 'Login broken',
      limit: 2,
    });
    expect(items.map((i) => i.workItemId)).toEqual(['a', 'b']);
    expect(items[0].score).toBe(0.9);
    expect(items[0].url).toContain('/issues/a');
  });

  it('returns [] when the AI provider is unavailable', async () => {
    const { svc, repo } = makeSvc([], {
      aiProvider: { isAvailable: jest.fn().mockReturnValue(false) },
    });
    const items = await svc.findSimilar({
      workspaceId: 'ws-1',
      userId: 'user-1',
      title: 'x',
    });
    expect(items).toEqual([]);
    expect(repo.similaritySearch).not.toHaveBeenCalled();
  });

  it('searches only plane_work_item chunks in the caller workspace, scoped to the caller readable spaces', async () => {
    const { svc, repo, spaceMemberRepo } = makeSvc([]);
    await svc.findSimilar({
      workspaceId: 'ws-1',
      userId: 'user-1',
      title: 'x',
      limit: 5,
    });
    expect(spaceMemberRepo.getUserSpaceIds).toHaveBeenCalledWith('user-1');
    expect(repo.similaritySearch).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        sourceKind: 'plane_work_item',
        spaceIds: ['space-1'],
        topK: 20, // limit * OVERSAMPLE(4)
      }),
    );
  });

  it('returns an empty result with no repo call when the caller has no readable spaces', async () => {
    const { svc, repo, aiProvider, spaceMemberRepo } = makeSvc([], {
      spaceMemberRepo: { getUserSpaceIds: jest.fn().mockResolvedValue([]) },
    });
    const items = await svc.findSimilar({
      workspaceId: 'ws-1',
      userId: 'user-1',
      title: 'x',
    });
    expect(items).toEqual([]);
    expect(spaceMemberRepo.getUserSpaceIds).toHaveBeenCalledWith('user-1');
    expect(aiProvider.embedMany).not.toHaveBeenCalled();
    expect(repo.similaritySearch).not.toHaveBeenCalled();
  });

  it('predicts labels weighted by similarity, normalized to confidences', async () => {
    const { svc } = makeSvc([
      chunk('a', 0.9, { labels: ['bug'] }),
      chunk('b', 0.6, { labels: ['bug', 'ui'] }),
      chunk('c', 0.5, { labels: ['story'] }),
    ]);
    const { labels } = await svc.predictLabels({
      workspaceId: 'ws-1',
      userId: 'user-1',
      title: 'Login broken',
    });
    expect(labels[0].label).toBe('bug'); // 0.9 + 0.6 dominates
    const total = labels.reduce((s, l) => s + l.confidence, 0);
    expect(total).toBeLessThanOrEqual(1.0001);
    expect(labels.map((l) => l.label)).toContain('story');
  });

  it('clamps negative similarity scores so a label gets zero weight and is excluded', async () => {
    const { svc } = makeSvc([
      chunk('a', 0.9, { labels: ['bug'] }),
      chunk('b', 0.6, { labels: ['bug', 'ui'] }),
      chunk('c', -0.2, { labels: ['junk'] }),
    ]);
    const { labels } = await svc.predictLabels({
      workspaceId: 'ws-1',
      userId: 'user-1',
      title: 'Login broken',
    });
    expect(labels.map((l) => l.label)).not.toContain('junk');
    for (const l of labels) {
      expect(l.confidence).toBeGreaterThanOrEqual(0);
      expect(l.confidence).toBeLessThanOrEqual(1);
    }
    const total = labels.reduce((s, l) => s + l.confidence, 0);
    expect(total).toBeLessThanOrEqual(1.0001);
  });

  it('combines title and description into one query embedding', async () => {
    const { svc, aiProvider } = makeSvc([]);
    await svc.findSimilar({
      workspaceId: 'ws-1',
      userId: 'user-1',
      title: 'Title',
      description: 'Desc',
    });
    expect(aiProvider.embedMany).toHaveBeenCalledWith(['Title\n\nDesc']);
  });
});

/**
 * Work items are indexed into the Hub space their project is mapped to, and
 * indexing runs as the person who created that mapping. Scoping retrieval by
 * space membership alone therefore hands one person's visible work to every
 * member of the space - including to a model. The source product has to
 * authorise the viewer.
 */
describe('WorkIntelService — authorisation against ConqrPlan', () => {
  it('asks ConqrPlan as the viewer, not as the bridge', async () => {
    const { svc, delegation } = makeSvc([chunk('a', 0.9)]);

    await svc.findSimilar({
      workspaceId: 'ws-1',
      userId: 'user-1',
      title: 'Login broken',
    });

    expect(delegation.mintCallContext).toHaveBeenCalledWith('user-1', 'ws-1', [
      'work-item:read',
    ]);
  });

  it('drops work items in a project the viewer cannot read', async () => {
    const { svc } = makeSvc(
      [chunk('a', 0.9, { projectId: 'proj-1' }), chunk('b', 0.8, { projectId: 'proj-secret' })],
      { plane: { listProjects: jest.fn().mockResolvedValue([{ id: 'proj-1' }]) } },
    );

    const items = await svc.findSimilar({
      workspaceId: 'ws-1',
      userId: 'user-1',
      title: 'Login broken',
    });

    expect(items.map((i) => i.workItemId)).toEqual(['a']);
  });

  it('returns nothing when the viewer can read no ConqrPlan project', async () => {
    // An unmapped person, or one with no project membership. Hub space
    // membership must not be enough on its own.
    const { svc, repo } = makeSvc([chunk('a', 0.9)], {
      plane: { listProjects: jest.fn().mockResolvedValue([]) },
    });

    expect(
      await svc.findSimilar({ workspaceId: 'ws-1', userId: 'outsider', title: 'x' }),
    ).toEqual([]);
    expect(repo.similaritySearch).not.toHaveBeenCalled();
  });

  it('fails closed when ConqrPlan cannot be asked', async () => {
    const { svc } = makeSvc([chunk('a', 0.9)], {
      plane: { listProjects: jest.fn().mockRejectedValue(new Error('plane down')) },
    });

    expect(
      await svc.findSimilar({ workspaceId: 'ws-1', userId: 'user-1', title: 'x' }),
    ).toEqual([]);
  });

  it('drops a chunk that cannot say which project it belongs to', async () => {
    const { svc } = makeSvc([chunk('a', 0.9, { projectId: undefined })]);

    expect(
      await svc.findSimilar({ workspaceId: 'ws-1', userId: 'user-1', title: 'x' }),
    ).toEqual([]);
  });

  it('does not leak labels through predict-labels either', async () => {
    const { svc } = makeSvc(
      [chunk('b', 0.8, { projectId: 'proj-secret', labels: ['confidential'] })],
      { plane: { listProjects: jest.fn().mockResolvedValue([{ id: 'proj-1' }]) } },
    );

    expect(
      await svc.predictLabels({ workspaceId: 'ws-1', userId: 'user-1', title: 'x' }),
    ).toEqual({ labels: [] });
  });
});
