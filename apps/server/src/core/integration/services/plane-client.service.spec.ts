import { PlaneClientService } from './plane-client.service';

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    isPlaneIntegrationEnabled: jest.fn().mockReturnValue(true),
    getPlaneApiUrl: jest.fn().mockReturnValue('http://plane.test/api/v1'),
    getPlaneApiKey: jest.fn().mockReturnValue('test-key'),
    getPlaneWorkspaceSlug: jest.fn().mockReturnValue('conqr'),
    getPlaneApiTimeoutMs: jest.fn().mockReturnValue(5000),
    ...overrides,
  } as any;
}

function mockFetchOnce(status: number, body: unknown) {
  // Mirrors a real Response: the client reads the body as text so that empty
  // 204s (membership removal) do not blow up on JSON.parse. Keeping `json`
  // here as well means a mock that only implements one of the two cannot
  // quietly pass.
  const text = body === undefined ? '' : JSON.stringify(body);
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => body,
  });
}

describe('PlaneClientService', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('lists labels for a project (handles bare-array response)', async () => {
    const svc = new PlaneClientService(makeEnv());
    mockFetchOnce(200, [{ id: 'l1', name: 'bug', color: '#f00' }]);

    const labels = await svc.listLabels('proj-1');

    expect(labels).toEqual([{ id: 'l1', name: 'bug', color: '#f00' }]);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(
      'http://plane.test/api/v1/workspaces/conqr/projects/proj-1/labels/',
    );
  });

  it('lists labels (handles paginated {results} response)', async () => {
    const svc = new PlaneClientService(makeEnv());
    mockFetchOnce(200, { results: [{ id: 'l2', name: 'story' }] });

    const labels = await svc.listLabels('proj-1');
    expect(labels).toEqual([{ id: 'l2', name: 'story' }]);
  });

  it('pages work items with a cursor and reports the next cursor', async () => {
    const svc = new PlaneClientService(makeEnv());
    mockFetchOnce(200, {
      results: [{ id: 'wi-1', name: 'First' }],
      next_cursor: '100:1:0',
      next_page_results: true,
    });

    const page = await svc.listWorkItemsPage('proj-1', { perPage: 100 });

    expect(page.results).toHaveLength(1);
    expect(page.nextCursor).toBe('100:1:0');
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain(
      'per_page=100',
    );
  });

  it('returns nextCursor null on the last page', async () => {
    const svc = new PlaneClientService(makeEnv());
    mockFetchOnce(200, {
      results: [{ id: 'wi-2', name: 'Last' }],
      next_cursor: '100:2:0',
      next_page_results: false,
    });

    const page = await svc.listWorkItemsPage('proj-1', {
      cursor: '100:1:0',
    });
    expect(page.nextCursor).toBeNull();
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain(
      'cursor=100%3A1%3A0',
    );
  });
});
