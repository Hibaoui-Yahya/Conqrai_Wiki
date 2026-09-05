import { DelegatedScope } from '../../../../core/integration/domain/delegated-token.util';
import { PlaneCallContext } from '../../../../core/integration/services/plane-client.service';
import { DelegatedTokenService } from '../../../../core/integration/services/delegated-token.service';
import { ChatToolContext } from './chat-tool.types';

/**
 * Turn the tool's caller context into a delegated ConqrPlan call context.
 *
 * Every ConqrPlan write from a tool goes through here, so there is exactly one
 * place where a human actor becomes a credential. Before delegation the tools
 * passed `ctx.user.id` in an unsigned header that ConqrPlan ignored, which
 * meant every write actually ran as the API key's owner: two different users
 * had identical power, and neither was the one being checked.
 *
 * The scopes are supplied per call site rather than being a blanket "act as
 * this user" grant, so a token minted to read cannot write and a token minted
 * to create a work item cannot reconfigure estimation. ConqrPlan then applies
 * the mapped user's own permissions on top; the scope only narrows what the
 * delegation may attempt.
 */
export function delegateForPlane(
  delegation: DelegatedTokenService,
  ctx: ChatToolContext,
  scope: DelegatedScope[],
): PlaneCallContext {
  const minted = delegation.mintForPlane({
    hubUserId: ctx.user.id,
    hubWorkspaceId: ctx.workspaceId,
    scope,
  });
  return { delegation: minted.token, correlationId: minted.jti };
}
