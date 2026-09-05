import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  MessageEvent,
  Post,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../casl/interfaces/workspace-ability.type';
import { RelationshipService } from './services/relationship.service';
import { ProjectSpaceMappingService } from './services/project-space-mapping.service';
import { SmartObjectResolverService } from './services/smart-object-resolver.service';
import { WorkItemCreationService } from './services/work-item-creation.service';
import { PlaneClientService } from './services/plane-client.service';
import { DelegatedTokenService } from './services/delegated-token.service';
import { DELEGATED_SCOPES } from './domain/delegated-token.util';
import { PlaneWebhookService } from './services/plane-webhook.service';
import { TraceabilityService } from './services/traceability.service';
import { NotificationDedupService } from './services/notification-dedup.service';
import { FederatedSearchService } from './services/federated-search.service';
import { RequirementService } from './services/requirement.service';
import { RequirementDeliveryService } from './services/requirement-delivery.service';
import { DeliveryReconciliationService } from './services/delivery-reconciliation.service';
import { IntegrationEventBus } from './services/integration-event-bus';
import { CrossProductInsightService } from './services/cross-product-insight.service';
import {
  BulkCreateWorkItemsDto,
  FederatedSearchDto,
  RegisterRequirementDto,
  TransitionRequirementDto,
  CreateRelationshipDto,
  CreateWorkItemFromHubDto,
  ListMappingsDto,
  ListRelationshipsDto,
  ResolveDto,
  SearchWorkItemsDto,
  SetMappingDto,
  PromotePageDto,
} from './dto/integration.dto';
import { PagePromotionService } from './services/page-promotion.service';

/**
 * Conqr Integration Layer HTTP surface (blueprint §5, §8). Source-product
 * authorization stays authoritative; these endpoints only manage the edges,
 * mappings and projections the Integration Layer owns.
 */
@UseGuards(JwtAuthGuard)
@Controller('integrations')
export class IntegrationController {
  constructor(
    private readonly relationships: RelationshipService,
    private readonly mappings: ProjectSpaceMappingService,
    private readonly resolver: SmartObjectResolverService,
    private readonly workItemCreation: WorkItemCreationService,
    private readonly plane: PlaneClientService,
    private readonly webhooks: PlaneWebhookService,
    private readonly traceability: TraceabilityService,
    private readonly notificationDedup: NotificationDedupService,
    private readonly federatedSearch: FederatedSearchService,
    private readonly requirements: RequirementService,
    private readonly requirementDelivery: RequirementDeliveryService,
    private readonly reconciliation: DeliveryReconciliationService,
    private readonly eventBus: IntegrationEventBus,
    private readonly insights: CrossProductInsightService,
    private readonly pagePromotion: PagePromotionService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    private readonly delegation: DelegatedTokenService,
  ) {}

  /** Live stream of integration refresh events for the current workspace (§8.4). */
  @Sse('events/stream')
  streamEvents(
    @AuthWorkspace() workspace: Workspace,
  ): Observable<MessageEvent> {
    return this.eventBus
      .streamForWorkspace(workspace.id)
      .pipe(map((e) => ({ data: e }) as MessageEvent));
  }

  @HttpCode(HttpStatus.OK)
  @Post('relationships/create')
  async createRelationship(
    @Body() dto: CreateRelationshipDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.relationships.create({
      workspaceId: workspace.id,
      actorId: user.id,
      sourceUrn: dto.sourceUrn,
      targetUrn: dto.targetUrn,
      relationType: dto.relationType,
      provenance: dto.provenance,
      sourceVersion: dto.sourceVersion,
      metadata: dto.metadata,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('relationships')
  async listRelationships(
    @Body() dto: ListRelationshipsDto,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const items = await this.relationships.listForUrn(workspace.id, dto.urn);
    return { items };
  }

  @HttpCode(HttpStatus.OK)
  @Post('relationships/remove')
  async removeRelationship(
    @Body('id') id: string,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.relationships.remove(workspace.id, id, user.id);
    return { success: true };
  }

  @HttpCode(HttpStatus.OK)
  @Post('mappings/set')
  async setMapping(
    @Body() dto: SetMappingDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.requireWorkspaceManage(user, workspace);
    return this.mappings.setMapping({
      workspaceId: workspace.id,
      actorId: user.id,
      planeProjectId: dto.planeProjectId,
      spaceId: dto.spaceId,
      mappingKind: dto.mappingKind,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('mappings')
  async listMappings(
    @Body() dto: ListMappingsDto,
    @AuthWorkspace() workspace: Workspace,
  ) {
    if (dto.planeProjectId) {
      return {
        items: await this.mappings.listForProject(
          workspace.id,
          dto.planeProjectId,
        ),
      };
    }
    if (dto.spaceId) {
      return {
        items: await this.mappings.listForSpace(workspace.id, dto.spaceId),
      };
    }
    // No filter → all mappings in the workspace (for the admin settings page).
    return { items: await this.mappings.listForWorkspace(workspace.id) };
  }

  @HttpCode(HttpStatus.OK)
  @Post('mappings/remove')
  async removeMapping(
    @Body('id') id: string,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.requireWorkspaceManage(user, workspace);
    await this.mappings.removeMapping(workspace.id, id, user.id);
    return { success: true };
  }

  /** Batch-resolve URNs into authorized presentation models for smart cards. */
  @HttpCode(HttpStatus.OK)
  @Post('resolve')
  async resolve(
    @Body() dto: ResolveDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const models = await this.resolver.resolveMany(dto.urns ?? [], {
      workspaceId: workspace.id,
      viewerId: user.id,
      planeProjectId: dto.planeProjectId,
      displayMode: dto.displayMode as any,
    });
    return { items: models };
  }

  // -------------------------------------------------------------------------
  // Vertical Slice 01: requirement -> linked ConqrPlan execution
  // -------------------------------------------------------------------------

  /**
   * Requirements on a page with their coverage and related work.
   *
   * Work is resolved as the *viewer*, so an item they cannot open comes back
   * as a restricted placeholder carrying no title, project, assignee or state.
   */
  @HttpCode(HttpStatus.OK)
  @Post('requirements/page')
  async pageRequirements(
    @Body() dto: { pageId: string; planeProjectId?: string },
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    // Returns { items, summary } — the summary carries the coverage contract
    // (total, approvedOrBeyond, covered, uncovered, provisional,
    // unresolvedSources, gaps) the panel renders its header from.
    return this.requirementDelivery.pageRequirements({
      workspaceId: workspace.id,
      viewerId: user.id,
      pageId: dto.pageId,
      planeProjectId: dto.planeProjectId,
    });
  }

  /**
   * What creating linked work would do. Changes nothing.
   *
   * The confirm step is separate because ConqrHub cannot undo the ConqrPlan
   * half: dropping the relationship later never deletes the work item.
   */
  @HttpCode(HttpStatus.OK)
  @Post('requirements/preview-linked-work')
  async previewLinkedWork(
    @Body()
    dto: {
      requirementId: string;
      planeProjectId?: string;
      title?: string;
      descriptionHtml?: string;
      priority?: string;
    },
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.requirementDelivery.previewLinkedWork({
      workspaceId: workspace.id,
      viewerId: user.id,
      ...dto,
    });
  }

  /**
   * Create the work item and record the canonical relationship.
   *
   * Runs under the acting user's delegation, so ConqrPlan authorises them and
   * not the bridge. Returns a receipt naming the created URN, the relationship
   * and its derived inverse, the actor and the correlation id. Safe to retry:
   * the idempotency key is derived from the requirement and project.
   */
  @HttpCode(HttpStatus.OK)
  @Post('requirements/create-linked-work')
  async createLinkedWork(
    @Body()
    dto: {
      requirementId: string;
      planeProjectId?: string;
      title?: string;
      descriptionHtml?: string;
      priority?: string;
    },
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.requirementDelivery.createLinkedWork({
      workspaceId: workspace.id,
      actorId: user.id,
      ...dto,
    });
  }

  /**
   * Run the delivery-projection reconciliation sweep now.
   *
   * The operational escape hatch for "ConqrPlan was down for an hour and I do
   * not want to wait for the next scheduled run". Scoped to the caller's
   * workspace, and it resolves through the same permission-shaped read path as
   * everything else - running it grants nobody extra visibility.
   */
  @HttpCode(HttpStatus.OK)
  @Post('delivery/reconcile')
  async reconcileDelivery(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const metrics = await this.reconciliation.reconcile({
      workspaceId: workspace.id,
    });
    return { requestedBy: user.id, ...metrics };
  }

  /** Create a Plane work item from a Hub selection and link it back (§5.1A). */
  @HttpCode(HttpStatus.OK)
  @Post('work-items/create-from-hub')
  async createWorkItemFromHub(
    @Body() dto: CreateWorkItemFromHubDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.workItemCreation.createFromHub({
      workspaceId: workspace.id,
      actorId: user.id,
      sourceUrn: dto.sourceUrn,
      planeProjectId: dto.planeProjectId,
      title: dto.title,
      descriptionHtml: dto.descriptionHtml,
      priority: dto.priority,
      relationType: dto.relationType,
    });
  }

  /** Bulk-create work items from a Hub table/checklist (§5.1B). */
  @HttpCode(HttpStatus.OK)
  @Post('work-items/bulk-create-from-hub')
  async bulkCreateFromHub(
    @Body() dto: BulkCreateWorkItemsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.workItemCreation.createManyFromHub({
      workspaceId: workspace.id,
      actorId: user.id,
      planeProjectId: dto.planeProjectId,
      rows: dto.rows,
    });
  }

  /**
   * List Plane projects in the configured workspace so the admin mapping UI can
   * show a picker of real project names instead of a raw UUID field (§8.3).
   */
  @HttpCode(HttpStatus.OK)
  @Post('plane/projects')
  async listPlaneProjects(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    if (!this.plane.isEnabled()) {
      return { items: [], integrationEnabled: false };
    }
    // The picker lists the projects this admin can see in ConqrPlan, not the
    // ones the bridge credential can reach.
    const items = await this.plane.listProjects(
      this.delegation.mintCallContext(user.id, workspace.id, [
        DELEGATED_SCOPES.workItemRead,
      ]),
    );
    return { items, integrationEnabled: true };
  }

  /** Search existing Plane work items to embed/link in a Hub page (§5.1C). */
  @HttpCode(HttpStatus.OK)
  @Post('work-items/search')
  async searchWorkItems(
    @Body() dto: SearchWorkItemsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    if (!this.plane.isEnabled()) {
      return { items: [], integrationEnabled: false };
    }
    const { results } = await this.plane.listWorkItems(
      dto.planeProjectId,
      { search: dto.search, perPage: 25 },
      this.delegation.mintCallContext(user.id, workspace.id, [
        DELEGATED_SCOPES.workItemRead,
      ]),
    );
    const items = results.map((wi) => ({
      urn: `conqr://plane/work-item/${wi.id}`,
      id: wi.id,
      key: wi.sequence_id ?? null,
      name: wi.name,
      state: wi.state_detail?.name ?? wi.state ?? null,
      priority: wi.priority ?? null,
    }));
    return { items, integrationEnabled: true };
  }

  /** Grounded, permission-aware cross-product status update draft (§6.5). */
  @HttpCode(HttpStatus.OK)
  @Post('insights/status-update')
  async statusUpdate(
    @Body('planeProjectId') planeProjectId: string | undefined,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.insights.statusUpdate(workspace.id, user.id, planeProjectId);
  }

  /** Resolve the Plane deep-link for a Hub space (context-aware app switch, §7.4). */
  @HttpCode(HttpStatus.OK)
  @Post('space-plane-target')
  async spacePlaneTarget(
    @Body('spaceId') spaceId: string,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.mappings.resolveSpacePlaneTarget(workspace.id, spaceId);
  }

  /** Resolve a Plane project's mapped Hub docs for the Plane Docs area (§5.2A). */
  @HttpCode(HttpStatus.OK)
  @Post('plane/project-docs')
  async projectDocs(
    @Body('planeProjectId') planeProjectId: string,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.mappings.resolveProjectDocs(workspace.id, planeProjectId);
  }

  /**
   * Browse a project's mapped documentation for the native Plane Docs area
   * (§5.2A): permission-filtered spaces + recent pages with absolute deep links.
   */
  @HttpCode(HttpStatus.OK)
  @Post('plane/project-docs/browse')
  async browseProjectDocs(
    @Body('planeProjectId') planeProjectId: string,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.mappings.browseProjectDocs(workspace.id, user, planeProjectId);
  }

  /**
   * Promote a Plane Project Note to a canonical Hub page (§4): one-way, with
   * provenance (`derived_from`) — never field-level sync.
   */
  @HttpCode(HttpStatus.OK)
  @Post('pages/promote')
  async promotePage(
    @Body() dto: PromotePageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.pagePromotion.promote({
      workspaceId: workspace.id,
      user,
      planeProjectId: dto.planeProjectId,
      planePageId: dto.planePageId,
      title: dto.title,
      contentHtml: dto.contentHtml,
    });
  }

  /** Register a requirement block for lifecycle tracking (§6.2). */
  @HttpCode(HttpStatus.OK)
  @Post('requirements/register')
  async registerRequirement(
    @Body() dto: RegisterRequirementDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.requirements.register({
      workspaceId: workspace.id,
      actorId: user.id,
      pageId: dto.pageId,
      blockId: dto.blockId,
      title: dto.title,
    });
  }

  /** Advance a requirement through its lifecycle (Draft→…→Verified) (§6.2). */
  @HttpCode(HttpStatus.OK)
  @Post('requirements/transition')
  async transitionRequirement(
    @Body() dto: TransitionRequirementDto,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.requirements.transition(workspace.id, dto.id, dto.state);
  }

  /** Approved requirements with missing/incomplete delivery work (§6.2). */
  @HttpCode(HttpStatus.OK)
  @Post('requirements/coverage-gaps')
  async requirementCoverageGaps(
    @Body('planeProjectId') planeProjectId: string | undefined,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.requirements.coverageGaps(workspace.id, user.id, planeProjectId);
  }

  /** Requirement/page delivery coverage over the typed edge graph (§6.2). */
  @HttpCode(HttpStatus.OK)
  @Post('traceability/coverage')
  async coverage(
    @Body() dto: ListRelationshipsDto & { planeProjectId?: string },
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.traceability.pageCoverage(
      workspace.id,
      dto.urn,
      user.id,
      (dto as any).planeProjectId,
    );
  }

  /** Permission-aware unified search across Hub knowledge + Plane work (§5.3B). */
  @HttpCode(HttpStatus.OK)
  @Post('search')
  async unifiedSearch(
    @Body() dto: FederatedSearchDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.federatedSearch.search(dto.query, {
      workspaceId: workspace.id,
      userId: user.id,
      planeProjectId: dto.planeProjectId,
    });
  }

  /** Recent deduped cross-product notifications — the bell's Suite feed (§5.3C). */
  @HttpCode(HttpStatus.OK)
  @Post('notifications/recent')
  async notificationsRecent(
    @Body('limit') limit: number | undefined,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return {
      items: await this.notificationDedup.recentForWorkspace(
        workspace.id,
        typeof limit === 'number' && limit > 0 ? Math.min(limit, 50) : 20,
      ),
    };
  }

  /** Deduplicated notifications for a cross-product action chain (§5.3C). */
  @HttpCode(HttpStatus.OK)
  @Post('notifications/for-correlation')
  async notificationsForCorrelation(
    @Body('correlationId') correlationId: string,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return {
      items: await this.notificationDedup.forCorrelation(
        workspace.id,
        correlationId,
      ),
    };
  }

  /** Integration health: dead-lettered webhook deliveries (§8.1, §10). */
  @HttpCode(HttpStatus.OK)
  @Post('webhooks/dead-letters')
  async deadLetters(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.requireWorkspaceManage(user, workspace);
    return { items: await this.webhooks.listDeadLettered() };
  }

  /** Replay a dead-lettered Plane webhook delivery (§10). */
  @HttpCode(HttpStatus.OK)
  @Post('webhooks/replay')
  async replayWebhook(
    @Body('deliveryId') deliveryId: string,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.requireWorkspaceManage(user, workspace);
    const result = await this.webhooks.replay(deliveryId);
    return { outcome: result.outcome };
  }

  private requireWorkspaceManage(user: User, workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
    ) {
      throw new ForbiddenException();
    }
  }
}
