import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createRelationship,
  createWorkItemFromHub,
  CreateWorkItemFromHubRequest,
  getMappingsForSpace,
  getRelationships,
  removeRelationship,
  resolveSmartObjects,
  searchWorkItems,
  createLinkedWork,
  getPageRequirements,
  previewLinkedWork,
  registerRequirement,
} from "@/features/integration/services/integration-service";
import {
  CreateRelationshipRequest,
  IntegrationRelationship,
  PresentationModel,
  ProjectSpaceMapping,
} from "@/features/integration/types/integration.types";

/** Project↔space mappings for a space (used to resolve Plane work items). */
export function useSpaceMappings(spaceId: string | undefined) {
  return useQuery<ProjectSpaceMapping[]>({
    queryKey: ["space-mappings", spaceId],
    queryFn: () => getMappingsForSpace(spaceId as string),
    enabled: Boolean(spaceId),
    staleTime: 5 * 60 * 1000,
  });
}

/** Resolve a set of URNs into presentation models (smart cards). */
export function useResolveSmartObjects(
  urns: string[],
  planeProjectId?: string,
) {
  return useQuery<PresentationModel[]>({
    queryKey: ["smart-objects", { urns, planeProjectId }],
    queryFn: () => resolveSmartObjects({ urns, planeProjectId }),
    enabled: urns.length > 0,
    // Work data is live-ish; refetch on focus so cards don't drift.
    staleTime: 10_000,
  });
}

/** All typed relationships touching a URN (for backlink/knowledge panels). */
export function useRelationships(urn: string | undefined) {
  return useQuery<IntegrationRelationship[]>({
    queryKey: ["relationships", urn],
    queryFn: () => getRelationships(urn as string),
    enabled: Boolean(urn),
  });
}

export function useCreateRelationshipMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateRelationshipRequest) => createRelationship(req),
    onSuccess: (rel) => {
      queryClient.invalidateQueries({
        queryKey: ["relationships", rel.sourceUrn],
      });
      queryClient.invalidateQueries({
        queryKey: ["relationships", rel.targetUrn],
      });
    },
  });
}

/** Search existing Plane work items in a project (to link/embed). */
export function useSearchWorkItems(
  planeProjectId: string | undefined,
  search: string,
) {
  return useQuery({
    queryKey: ["work-item-search", planeProjectId, search],
    queryFn: () => searchWorkItems(planeProjectId as string, search),
    enabled: Boolean(planeProjectId),
    staleTime: 15_000,
  });
}

/** Create a Plane work item from a Hub source and link it back. */
export function useCreateWorkItemFromHubMutation(affectedUrns: string[] = []) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateWorkItemFromHubRequest) =>
      createWorkItemFromHub(req),
    onSuccess: () => {
      affectedUrns.forEach((urn) =>
        queryClient.invalidateQueries({ queryKey: ["relationships", urn] }),
      );
    },
  });
}

export function useRemoveRelationshipMutation(affectedUrns: string[] = []) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => removeRelationship(id),
    onSuccess: () => {
      affectedUrns.forEach((urn) =>
        queryClient.invalidateQueries({ queryKey: ["relationships", urn] }),
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Vertical Slice 01 — requirement to linked execution
// ---------------------------------------------------------------------------

export const PAGE_REQUIREMENTS_KEY = "page-requirements";

/**
 * Requirements on a page with coverage and permission-shaped related work.
 *
 * Keyed on the page so an SSE work-item change can invalidate exactly this,
 * and no polling is needed: live updates arrive through useIntegrationEvents.
 */
export function usePageRequirements(
  pageId: string | undefined,
  planeProjectId?: string,
) {
  return useQuery({
    queryKey: [PAGE_REQUIREMENTS_KEY, pageId, planeProjectId],
    queryFn: () => getPageRequirements(pageId!, planeProjectId),
    enabled: !!pageId,
  });
}

/**
 * Fetch the preview for a requirement.
 *
 * A mutation rather than a query even though it reads: it is triggered by the
 * user opening the dialog, not by rendering, and firing it on render would
 * make an unbounded number of cross-product calls as a page scrolls.
 */
export function usePreviewLinkedWorkMutation() {
  return useMutation({ mutationFn: previewLinkedWork });
}

export function useCreateLinkedWorkMutation(pageId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createLinkedWork,
    onSuccess: () => {
      // Coverage and the related-work cards both change.
      queryClient.invalidateQueries({ queryKey: [PAGE_REQUIREMENTS_KEY, pageId] });
      queryClient.invalidateQueries({ queryKey: ["smart-objects"] });
    },
  });
}

export function useRegisterRequirementMutation(pageId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: registerRequirement,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [PAGE_REQUIREMENTS_KEY, pageId] });
    },
  });
}
