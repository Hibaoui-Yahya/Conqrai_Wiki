import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  CONQRPLAN_AUDIENCE,
  DelegatedClaims,
  DelegatedScope,
  mintDelegatedToken,
  verifyDelegatedToken,
  VerifyResult,
} from '../domain/delegated-token.util';
import { toOrgUid, toPersonUid } from '../domain/canonical-identity.util';

/**
 * Short-lived by design. A delegation is minted immediately before the call it
 * authorises and is useless minutes later, so a token captured from a log or a
 * proxy has almost no window. Five minutes covers a slow ConqrPlan write plus
 * clock skew without becoming a portable credential.
 */
const DEFAULT_TTL_SECONDS = 300;

/** Tolerance for clock drift between ConqrHub and ConqrPlan. */
const CLOCK_SKEW_SECONDS = 30;

export interface MintedDelegation {
  token: string;
  /** Token id, also used as the correlation id for the whole exchange. */
  jti: string;
  personUid: string;
  orgUid: string;
  scope: string[];
  expiresAt: number;
}

/**
 * Issues and validates on-behalf-of tokens for cross-product calls
 * (blueprint §9.1).
 *
 * ConqrHub authenticates the human and checks that they may request the
 * action; this service then states that fact in a form ConqrPlan can verify
 * on its own. It does not grant anything: ConqrPlan still applies its own
 * authorization to the mapped user, and remains the final authority.
 */
@Injectable()
export class DelegatedTokenService {
  private readonly logger = new Logger(DelegatedTokenService.name);
  private warnedAboutSharedSecret = false;

  constructor(private readonly environment: EnvironmentService) {}

  private now(): number {
    return Math.floor(Date.now() / 1000);
  }

  private signingKey(): string {
    if (!this.environment.isDelegationKeyDedicated() && !this.warnedAboutSharedSecret) {
      // Once per process: loud enough to fix, quiet enough not to spam.
      this.logger.warn(
        'CONQR_OBO_SIGNING_KEY is not set; delegated tokens are signed with APP_SECRET. ' +
          'Any product holding that key can mint ConqrHub sessions. Set a dedicated key.',
      );
      this.warnedAboutSharedSecret = true;
    }
    return this.environment.getDelegationSigningKey();
  }

  /**
   * Mint a delegation for one ConqrPlan operation.
   *
   * Takes ConqrHub's local ids and converts them to canonical identifiers at
   * this boundary, so no caller has to remember to do it and no ConqrHub row
   * id can leak into a cross-product token.
   */
  mintForPlane(params: {
    hubUserId: string;
    hubWorkspaceId: string;
    scope: DelegatedScope[];
    ttlSeconds?: number;
  }): MintedDelegation {
    const personUid = toPersonUid(params.hubUserId);
    const orgUid = toOrgUid(params.hubWorkspaceId);
    const nowSeconds = this.now();
    const ttl = params.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const jti = randomUUID();

    const token = mintDelegatedToken(
      {
        sub: personUid,
        tid: orgUid,
        aud: CONQRPLAN_AUDIENCE,
        scope: params.scope,
        ttlSeconds: ttl,
        nowSeconds,
        issuer: this.environment.getDelegationIssuer(),
        jti,
      },
      this.signingKey(),
    );

    return {
      token,
      jti,
      personUid,
      orgUid,
      scope: params.scope,
      expiresAt: nowSeconds + ttl,
    };
  }

  /**
   * Mint a delegation already shaped as a ConqrPlan call context.
   *
   * Services and controllers hold a user id and a workspace id rather than a
   * `ChatToolContext`, so they cannot use `delegateForPlane`. Without this they
   * were calling ConqrPlan with no delegation at all, which meant the reply
   * described what the *bridge credential* could see - not what the viewer
   * could. Every read path now names a human.
   */
  mintCallContext(
    hubUserId: string,
    hubWorkspaceId: string,
    scope: DelegatedScope[],
  ): { delegation: string; correlationId: string } {
    const minted = this.mintForPlane({ hubUserId, hubWorkspaceId, scope });
    return { delegation: minted.token, correlationId: minted.jti };
  }

  /**
   * Verify a delegation. Used by ConqrHub's own inbound delegated endpoints;
   * ConqrPlan verifies independently with the same contract.
   */
  verify(
    token: string | undefined,
    audience: string,
    requiredScope?: string,
  ): VerifyResult {
    return verifyDelegatedToken(
      token,
      {
        audience,
        requiredScope,
        nowSeconds: this.now(),
        issuer: this.environment.getDelegationIssuer(),
        clockSkewSeconds: CLOCK_SKEW_SECONDS,
      },
      this.signingKey(),
    );
  }
}

export type { DelegatedClaims };
