import { Module } from '@nestjs/common';
import { RagModule } from '../rag/rag.module';
import { AiProviderModule } from '../providers/ai-provider.module';
import { SearchModule } from '../../../core/search/search.module';
import { EnvironmentModule } from '../../../integrations/environment/environment.module';
import { PageModule } from '../../../core/page/page.module';
import { SpaceModule } from '../../../core/space/space.module';
import { CommentModule } from '../../../core/comment/comment.module';
import { WorkspaceModule } from '../../../core/workspace/workspace.module';
import { UserModule } from '../../../core/user/user.module';
import { IntegrationModule } from '../../../core/integration/integration.module';
import { PageVerificationModule } from '../../page-verification/page-verification.module';
import { AiChatController } from './ai-chat.controller';
import { AiChatStreamController } from './ai-chat-stream.controller';
import { AiChatService } from './ai-chat.service';
import { AiChatStreamService } from './ai-chat-stream.service';
import { AiChatTitleService } from './ai-chat-title.service';
import { ChatToolRegistry } from './tools/chat-tool.registry';
import SpaceAbilityFactory from '../../../core/casl/abilities/space-ability.factory';
import WorkspaceAbilityFactory from '../../../core/casl/abilities/workspace-ability.factory';
// P4 tools
import { SearchPagesTool } from './tools/search-pages.tool';
import { RagRetrieveTool } from './tools/rag-retrieve.tool';
// P5 read tools
import { GetPageTool } from './tools/get-page.tool';
import { ListRecentPagesTool } from './tools/list-recent-pages.tool';
import { ListSpacePagesTool } from './tools/list-space-pages.tool';
import { GetPageBreadcrumbsTool } from './tools/get-page-breadcrumbs.tool';
import { ListSpacesTool } from './tools/list-spaces.tool';
import { GetSpaceInfoTool } from './tools/get-space-info.tool';
import { GetPageCommentsTool } from './tools/get-page-comments.tool';
import { GetPageHistoryTool } from './tools/get-page-history.tool';
// P5 write tools
import { CreatePageTool } from './tools/create-page.tool';
import { UpdatePageTitleTool } from './tools/update-page-title.tool';
import { UpdatePageContentTool } from './tools/update-page-content.tool';
import { MovePageTool } from './tools/move-page.tool';
import { CreateCommentTool } from './tools/create-comment.tool';
// P6 read tools
// list_pages / get_comments removed in favor of list_space_pages / get_page_comments
// (identical implementations — keeping the more descriptive names)
import { ListChildPagesTool } from './tools/list-child-pages.tool';
import { GetSpaceTool } from './tools/get-space.tool';
import { SearchAttachmentsTool } from './tools/search-attachments.tool';
import { ListWorkspaceMembersTool } from './tools/list-workspace-members.tool';
import { GetCurrentUserTool } from './tools/get-current-user.tool';
// P6 write tools
import { UpdatePageTool } from './tools/update-page.tool';
import { DuplicatePageTool } from './tools/duplicate-page.tool';
import { CopyPageToSpaceTool } from './tools/copy-page-to-space.tool';
import { MovePageToSpaceTool } from './tools/move-page-to-space.tool';
import { CreateSpaceTool } from './tools/create-space.tool';
import { UpdateSpaceTool } from './tools/update-space.tool';
import { UpdateCommentTool } from './tools/update-comment.tool';
import { DeletePageTool } from './tools/delete-page.tool';
import { DeleteCommentTool } from './tools/delete-comment.tool';
import { AddDiagramTool } from './tools/add-diagram.tool';
// Attachment / media reading (documents + images + drawings into the chat)
import { ReadAttachmentTool } from './tools/read-attachment.tool';
import { ListPageAttachmentsTool } from './tools/list-page-attachments.tool';
import { ReadPageMediaTool } from './tools/read-page-media.tool';
// Verification tools (control RAG eligibility)
import { GetVerificationStatusTool } from './tools/get-verification-status.tool';
import { ListUnverifiedPagesTool } from './tools/list-unverified-pages.tool';
import { VerifyPageTool } from './tools/verify-page.tool';
import { VERIFICATION_LIFECYCLE_TOOLS } from './tools/verification-lifecycle.tools';
// Self-documenting guide tool (deep how-tos on using all the tools)
import { GetGuideTool } from './tools/get-guide.tool';
// Cross-product ConqrPlan tools
import { PLANE_WORK_ITEM_TOOLS } from './tools/plane-work-items.tools';
import { PLANE_WORK_MANAGEMENT_TOOLS } from './tools/plane-work-management.tools';
import { PLANE_CONTROL_TOOLS } from './tools/plane-control.tools';
// Suite integration tools (federated search, links, create-and-link, coverage)
import { SUITE_INTEGRATION_TOOLS } from './tools/suite-integration.tools';

// AiChatRepo and AiChatMessageRepo are registered in the @Global() DatabaseModule
// and are therefore available here without a local re-registration.
@Module({
  imports: [
    EnvironmentModule,
    AiProviderModule,
    RagModule,
    SearchModule,
    PageModule,
    SpaceModule,
    CommentModule,
    WorkspaceModule,
    UserModule,
    IntegrationModule,
    PageVerificationModule,
  ],
  controllers: [AiChatController, AiChatStreamController],
  providers: [
    AiChatService,
    AiChatStreamService,
    AiChatTitleService,
    ChatToolRegistry,
    SpaceAbilityFactory,
    WorkspaceAbilityFactory,
    // P4
    SearchPagesTool,
    RagRetrieveTool,
    // P5 read
    GetPageTool,
    ListRecentPagesTool,
    ListSpacePagesTool,
    GetPageBreadcrumbsTool,
    ListSpacesTool,
    GetSpaceInfoTool,
    GetPageCommentsTool,
    GetPageHistoryTool,
    // P5 write
    CreatePageTool,
    UpdatePageTitleTool,
    UpdatePageContentTool,
    MovePageTool,
    CreateCommentTool,
    // P6 read
    ListChildPagesTool,
    GetSpaceTool,
    SearchAttachmentsTool,
    ListWorkspaceMembersTool,
    GetCurrentUserTool,
    // P6 write
    UpdatePageTool,
    DuplicatePageTool,
    CopyPageToSpaceTool,
    MovePageToSpaceTool,
    CreateSpaceTool,
    UpdateSpaceTool,
    UpdateCommentTool,
    DeletePageTool,
    DeleteCommentTool,
    AddDiagramTool,
    // Attachment / media reading (documents + images + drawings into the chat)
    ReadAttachmentTool,
    ListPageAttachmentsTool,
    ReadPageMediaTool,
    // Verification tools (control RAG eligibility)
    GetVerificationStatusTool,
    ListUnverifiedPagesTool,
    VerifyPageTool,
    ...VERIFICATION_LIFECYCLE_TOOLS,
    // Self-documenting guide tool
    GetGuideTool,
    // Cross-product ConqrPlan tools
    ...PLANE_WORK_ITEM_TOOLS,
    ...PLANE_WORK_MANAGEMENT_TOOLS,
    ...PLANE_CONTROL_TOOLS,
    // Suite integration tools (federated search, links, create-and-link, coverage)
    ...SUITE_INTEGRATION_TOOLS,
  ],
  exports: [ChatToolRegistry],
})
export class AiChatModule {}
