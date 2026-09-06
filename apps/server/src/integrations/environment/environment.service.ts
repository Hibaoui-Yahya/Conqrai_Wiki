import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import ms, { StringValue } from 'ms';

@Injectable()
export class EnvironmentService {
  constructor(private configService: ConfigService) {}

  getNodeEnv(): string {
    return this.configService.get<string>('NODE_ENV', 'development');
  }

  isDevelopment(): boolean {
    return this.getNodeEnv() === 'development';
  }

  getAppUrl(): string {
    const rawUrl =
      this.configService.get<string>('APP_URL') ||
      `http://localhost:${this.getPort()}`;

    const { origin } = new URL(rawUrl);
    return origin;
  }

  isHttps(): boolean {
    const appUrl = this.configService.get<string>('APP_URL');
    try {
      const url = new URL(appUrl);
      return url.protocol === 'https:';
    } catch (error) {
      return false;
    }
  }

  /**
   * SameSite policy for the auth cookie. The suite embeds ConqrHub-authenticated
   * surfaces (e.g. the ConqrService launcher) as cross-site iframes; a Lax cookie
   * is withheld on those cross-site requests, so the embedded app can't see the
   * Hub session and forces a re-login. `None` (which browsers require to pair with
   * `Secure`) lets the session travel into those frames. Only viable over HTTPS —
   * on plain-HTTP dev, `None` is rejected, so fall back to `lax`.
   */
  getAuthCookieSameSite(): 'none' | 'lax' {
    return this.isHttps() ? 'none' : 'lax';
  }

  getSubdomainHost(): string {
    return this.configService.get<string>('SUBDOMAIN_HOST');
  }

  getPort(): number {
    return parseInt(this.configService.get<string>('PORT', '3000'));
  }

  getAppSecret(): string {
    return this.configService.get<string>('APP_SECRET');
  }

  getDatabaseURL(): string {
    return this.configService.get<string>('DATABASE_URL');
  }

  getDatabaseMaxPool(): number {
    return parseInt(this.configService.get<string>('DATABASE_MAX_POOL', '10'));
  }

  getRedisUrl(): string {
    return this.configService.get<string>(
      'REDIS_URL',
      'redis://localhost:6379',
    );
  }

  getJwtTokenExpiresIn(): string {
    return this.configService.get<string>('JWT_TOKEN_EXPIRES_IN', '90d');
  }

  getCookieExpiresIn(): Date {
    const expiresInStr = this.getJwtTokenExpiresIn();
    let msUntilExpiry: number;
    try {
      msUntilExpiry = ms(expiresInStr as StringValue);
    } catch (err) {
      msUntilExpiry = ms('90d');
    }
    return new Date(Date.now() + msUntilExpiry);
  }

  getGotenbergUrl(): string | undefined {
    return this.configService.get<string>('GOTENBERG_URL');
  }

  getStorageDriver(): string {
    return this.configService.get<string>('STORAGE_DRIVER', 'local');
  }

  getFileUploadSizeLimit(): string {
    return this.configService.get<string>('FILE_UPLOAD_SIZE_LIMIT', '50mb');
  }

  getFileImportSizeLimit(): string {
    return this.configService.get<string>('FILE_IMPORT_SIZE_LIMIT', '200mb');
  }

  getAwsS3AccessKeyId(): string {
    return this.configService.get<string>('AWS_S3_ACCESS_KEY_ID');
  }

  getAwsS3SecretAccessKey(): string {
    return this.configService.get<string>('AWS_S3_SECRET_ACCESS_KEY');
  }

  getAwsS3Region(): string {
    return this.configService.get<string>('AWS_S3_REGION');
  }

  getAwsS3Bucket(): string {
    return this.configService.get<string>('AWS_S3_BUCKET');
  }

  getAwsS3Endpoint(): string {
    return this.configService.get<string>('AWS_S3_ENDPOINT');
  }

  getAwsS3ForcePathStyle(): boolean {
    return this.configService.get<boolean>('AWS_S3_FORCE_PATH_STYLE');
  }

  getAwsS3Url(): string {
    return this.configService.get<string>('AWS_S3_URL');
  }

  getMailDriver(): string {
    return this.configService.get<string>('MAIL_DRIVER', 'log');
  }

  getMailFromAddress(): string {
    return this.configService.get<string>('MAIL_FROM_ADDRESS');
  }

  getMailFromName(): string {
    return this.configService.get<string>('MAIL_FROM_NAME', 'ConqrAI Wiki');
  }

  getSmtpHost(): string {
    return this.configService.get<string>('SMTP_HOST');
  }

  getSmtpPort(): number {
    return parseInt(this.configService.get<string>('SMTP_PORT'));
  }

  getSmtpSecure(): boolean {
    const secure = this.configService
      .get<string>('SMTP_SECURE', 'false')
      .toLowerCase();
    return secure === 'true';
  }

  getSmtpIgnoreTLS(): boolean {
    const ignoretls = this.configService
      .get<string>('SMTP_IGNORETLS', 'false')
      .toLowerCase();
    return ignoretls === 'true';
  }

  getSmtpUsername(): string {
    return this.configService.get<string>('SMTP_USERNAME');
  }

  getSmtpPassword(): string {
    return this.configService.get<string>('SMTP_PASSWORD');
  }

  getPostmarkToken(): string {
    return this.configService.get<string>('POSTMARK_TOKEN');
  }

  getDrawioUrl(): string {
    return this.configService.get<string>('DRAWIO_URL');
  }

  isCloud(): boolean {
    const cloudConfig = this.configService
      .get<string>('CLOUD', 'false')
      .toLowerCase();
    return cloudConfig === 'true';
  }

  isSelfHosted(): boolean {
    return !this.isCloud();
  }

  getStripePublishableKey(): string {
    return this.configService.get<string>('STRIPE_PUBLISHABLE_KEY');
  }

  getStripeSecretKey(): string {
    return this.configService.get<string>('STRIPE_SECRET_KEY');
  }

  getStripeWebhookSecret(): string {
    return this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
  }

  getBillingTrialDays(): number {
    return parseInt(this.configService.get<string>('BILLING_TRIAL_DAYS', '14'));
  }

  getCollabUrl(): string {
    return this.configService.get<string>('COLLAB_URL');
  }

  isCollabDisableRedis(): boolean {
    const isStandalone = this.configService
      .get<string>('COLLAB_DISABLE_REDIS', 'false')
      .toLowerCase();
    return isStandalone === 'true';
  }

  isDisableTelemetry(): boolean {
    const disable = this.configService
      .get<string>('DISABLE_TELEMETRY', 'false')
      .toLowerCase();
    return disable === 'true';
  }

  getPostHogHost(): string {
    return this.configService.get<string>('POSTHOG_HOST');
  }

  getPostHogKey(): string {
    return this.configService.get<string>('POSTHOG_KEY');
  }

  getSearchDriver(): string {
    return this.configService
      .get<string>('SEARCH_DRIVER', 'database')
      .toLowerCase();
  }

  getTypesenseUrl(): string {
    return this.configService
      .get<string>('TYPESENSE_URL', 'http://localhost:8108')
      .toLowerCase();
  }

  getTypesenseApiKey(): string {
    return this.configService.get<string>('TYPESENSE_API_KEY');
  }

  getTypesenseLocale(): string {
    return this.configService
      .get<string>('TYPESENSE_LOCALE', 'en')
      .toLowerCase();
  }

  getAiDriver(): string {
    return this.configService.get<string>('AI_DRIVER');
  }

  getAiEmbeddingModel(): string {
    return this.configService.get<string>('AI_EMBEDDING_MODEL');
  }

  getAiCompletionModel(): string {
    return this.configService.get<string>('AI_COMPLETION_MODEL');
  }

  getAiChatModel(): string {
    return (
      this.configService.get<string>('AI_CHAT_MODEL') ||
      this.configService.get<string>('AI_COMPLETION_MODEL')
    );
  }

  getAiEmbeddingDimension(): number {
    return parseInt(
      this.configService.get<string>('AI_EMBEDDING_DIMENSION'),
      10,
    );
  }

  getAiEmbeddingSupportsMrl(): boolean | undefined {
    const val = this.configService.get<string>('AI_EMBEDDING_SUPPORTS_MRL');
    if (val === undefined || val === null || val === '') return undefined;
    return val === 'true';
  }

  getOpenAiApiKey(): string {
    return this.configService.get<string>('OPENAI_API_KEY');
  }

  getOpenAiApiUrl(): string {
    return this.configService.get<string>('OPENAI_API_URL');
  }

  getGeminiApiKey(): string {
    return this.configService.get<string>('GEMINI_API_KEY');
  }

  getMistralApiKey(): string {
    return this.configService.get<string>('MISTRAL_API_KEY');
  }

  getAiSttEnabled(): boolean {
    const raw = this.configService.get<string>('AI_STT_ENABLED');
    if (raw == null || raw === '') {
      // Default: enabled when a Mistral key is configured.
      return Boolean(this.configService.get<string>('MISTRAL_API_KEY'));
    }
    return !['false', '0', 'no', 'off'].includes(
      String(raw).trim().toLowerCase(),
    );
  }

  getAiSttModel(): string {
    return (
      this.configService.get<string>('AI_STT_MODEL') || 'voxtral-mini-latest'
    );
  }

  getFfmpegPath(): string | undefined {
    return this.configService.get<string>('FFMPEG_PATH');
  }

  getOllamaApiUrl(): string {
    return this.configService.get<string>(
      'OLLAMA_API_URL',
      'http://localhost:11434',
    );
  }

  getDocHealthExternalChecksEnabled(): boolean {
    const raw = this.configService.get<string>('DOC_HEALTH_EXTERNAL_CHECKS');
    if (raw == null) return true;
    const normalized = String(raw).trim().toLowerCase();
    return !['false', '0', 'no', 'off', ''].includes(normalized);
  }

  getDocHealthExternalCheckTimeoutMs(): number {
    const raw = this.configService.get<string>(
      'DOC_HEALTH_EXTERNAL_CHECK_TIMEOUT_MS',
    );
    const parsed = raw == null ? 5000 : Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return 5000;
    return Math.min(parsed, 30_000);
  }

  getDocHealthExternalCheckConcurrency(): number {
    const raw = this.configService.get<string>(
      'DOC_HEALTH_EXTERNAL_CHECK_CONCURRENCY',
    );
    const parsed = raw == null ? 5 : Number(raw);
    if (!Number.isFinite(parsed) || parsed < 1) return 5;
    return Math.min(Math.floor(parsed), 32);
  }

  getEventStoreDriver(): string {
    return this.configService
      .get<string>('EVENT_STORE_DRIVER', 'postgres')
      .toLowerCase();
  }

  getClickHouseUrl(): string {
    return this.configService.get<string>('CLICKHOUSE_URL');
  }

  getAiEmbeddingBatchSize(): number {
    const raw = this.configService.get<string>('AI_EMBEDDING_BATCH_SIZE', '32');
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 32;
  }

  getAiEmbeddingChunkChars(): number {
    const raw = this.configService.get<string>(
      'AI_EMBEDDING_CHUNK_CHARS',
      '1600',
    );
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1600;
  }

  getAiEmbeddingChunkOverlap(): number {
    const raw = this.configService.get<string>(
      'AI_EMBEDDING_CHUNK_OVERLAP',
      '200',
    );
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 200;
  }

  /**
   * Minimum cosine similarity (0–1) a retrieved chunk must clear to be used as
   * RAG context. Drops weak matches so the model isn't grounded on irrelevant
   * content. Default 0.2; set AI_RAG_MIN_SCORE=0 to disable filtering.
   */
  getAiRagMinScore(): number {
    const raw = this.configService.get<string>('AI_RAG_MIN_SCORE', '0.2');
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return 0.2;
    return Math.min(parsed, 1);
  }

  // ---------------------------------------------------------------------------
  // Plane integration (Conqr Integration Layer). ConqrHub never touches Plane's
  // database — it calls Plane's REST API and receives signed webhooks.
  // ---------------------------------------------------------------------------

  /** Base URL of the Plane REST API, e.g. https://plane.example.com/api/v1 */
  getPlaneApiUrl(): string {
    const raw = this.configService.get<string>('PLANE_API_URL', '');
    return raw.replace(/\/+$/, '');
  }

  /** Plane API key (sent as the `X-Api-Key` header). */
  getPlaneApiKey(): string {
    return this.configService.get<string>('PLANE_API_KEY', '');
  }

  /**
   * Default Plane workspace slug.
   *
   * Delegated (on-behalf-of) calls must not depend on this: the tenant comes
   * from the delegated token and ConqrPlan validates it against the acting
   * user's membership. It remains a default for non-delegated read paths and
   * for local development.
   */
  getPlaneWorkspaceSlug(): string {
    return this.configService.get<string>('PLANE_WORKSPACE_SLUG', '');
  }

  /**
   * Signing key for cross-product on-behalf-of tokens.
   *
   * Deliberately NOT the app secret. ConqrPlan must hold this key to verify
   * delegations, and the app secret also signs ConqrHub sessions and share
   * links - handing that to another product would let ConqrPlan mint ConqrHub
   * sessions. This key only mints and verifies OBO tokens for the ConqrPlan
   * audience, so compromising ConqrPlan cannot escalate into ConqrHub.
   *
   * Falls back to the app secret when unset so existing deployments keep
   * working; isDelegationKeyDedicated() reports the fallback so it can be
   * surfaced rather than silently accepted.
   */
  getDelegationSigningKey(): string {
    return (
      this.configService.get<string>('CONQR_OBO_SIGNING_KEY', '') ||
      this.getAppSecret()
    );
  }

  /** False when the OBO key has fallen back to the shared app secret. */
  isDelegationKeyDedicated(): boolean {
    return Boolean(this.configService.get<string>('CONQR_OBO_SIGNING_KEY', ''));
  }

  /** Issuer stamped into delegated tokens (`iss`) and required by ConqrPlan. */
  getDelegationIssuer(): string {
    return this.configService.get<string>('CONQR_OBO_ISSUER', 'conqrhub');
  }

  /**
   * Base URL of the Plane WEB app (for deep links / app switching), distinct
   * from the REST API URL. Falls back to deriving from the API URL by stripping
   * a trailing `/api/...` segment.
   */
  getPlaneAppUrl(): string {
    const explicit = this.configService.get<string>('PLANE_APP_URL', '');
    if (explicit) return explicit.replace(/\/+$/, '');
    const api = this.getPlaneApiUrl();
    return api ? api.replace(/\/api(\/.*)?$/, '') : '';
  }

  /** Shared secret used to verify Plane webhook HMAC-SHA256 signatures. */
  // -- ConqrPlan MCP routing -------------------------------------------------
  //
  // Empty URL or empty routed-tool list means every tool stays local, so
  // deploying the service changes nothing until a route is turned on.

  /** Base URL of the extracted ConqrPlan MCP service. Empty disables routing. */
  getConqrPlanMcpUrl(): string {
    return this.configService.get<string>('CONQRPLAN_MCP_URL', '');
  }

  /** Tool names routed to the MCP service. `*` routes all seventeen. */
  getConqrPlanMcpRoutedTools(): string[] {
    return this.configService
      .get<string>('CONQRPLAN_MCP_ROUTED_TOOLS', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** Bearer token identifying Hub to the MCP service. */
  getConqrPlanMcpClientToken(): string {
    return this.configService.get<string>('CONQRPLAN_MCP_CLIENT_TOKEN', '');
  }

  getConqrPlanMcpTimeoutMs(): number {
    return Number(this.configService.get<string>('CONQRPLAN_MCP_TIMEOUT_MS', '30000'));
  }

  /**
   * Life of an assertion Hub issues to the MCP service.
   *
   * Short, and it caps everything derived from it: the service may not mint a
   * ConqrPlan token that outlives the assertion it came from.
   */
  getConqrPlanMcpAssertionTtlSeconds(): number {
    return Number(
      this.configService.get<string>('CONQRPLAN_MCP_ASSERTION_TTL_SECONDS', '120'),
    );
  }

  /** Hub's Ed25519 private key for service assertions (PKCS#8 PEM). */
  getConqrHubAssertionPrivateKey(): string {
    return this.configService.get<string>('CONQRHUB_ASSERTION_PRIVATE_KEY_PEM', '');
  }

  /** Key id the MCP service registers Hub's public key under. */
  getConqrHubAssertionKeyId(): string {
    return this.configService.get<string>('CONQRHUB_ASSERTION_KEY_ID', '');
  }

  getConqrOboIssuer(): string {
    return this.configService.get<string>('CONQR_OBO_ISSUER', 'conqrhub');
  }

  getPlaneWebhookSecret(): string {
    return this.configService.get<string>('PLANE_WEBHOOK_SECRET', '');
  }

  /**
   * Documented Plane API-key limit is 60 req/min; we stay a little under it so
   * caching/batching/backoff have headroom.
   */
  getPlaneApiRateLimitPerMinute(): number {
    const raw = this.configService.get<string>(
      'PLANE_API_RATE_LIMIT_PER_MINUTE',
      '55',
    );
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 55;
  }

  getPlaneApiTimeoutMs(): number {
    const raw = this.configService.get<string>('PLANE_API_TIMEOUT_MS', '10000');
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 10_000;
    return Math.min(parsed, 30_000);
  }

  /**
   * The integration is only "enabled" when the API URL + key are configured.
   * When disabled, cross-product features degrade to `integration_disabled`
   * rather than erroring.
   */
  isPlaneIntegrationEnabled(): boolean {
    return Boolean(this.getPlaneApiUrl() && this.getPlaneApiKey());
  }

  // ---------------------------------------------------------------------------
  // Shared-IdP OIDC login (Conqr single sign-on, blueprint §9.1). One OIDC
  // provider for the suite; when unset, OIDC login is simply unavailable.
  // ---------------------------------------------------------------------------
  getOidcIssuerUrl(): string {
    return this.configService.get<string>('OIDC_ISSUER_URL', '');
  }

  getOidcClientId(): string {
    return this.configService.get<string>('OIDC_CLIENT_ID', '');
  }

  getOidcClientSecret(): string {
    return this.configService.get<string>('OIDC_CLIENT_SECRET', '');
  }

  /** Callback URL registered with the IdP; defaults to APP_URL + standard path. */
  getOidcRedirectUri(): string {
    return (
      this.configService.get<string>('OIDC_REDIRECT_URI') ||
      `${this.getAppUrl()}/api/auth/oidc/callback`
    );
  }

  isOidcEnabled(): boolean {
    return Boolean(
      this.getOidcIssuerUrl() &&
      this.getOidcClientId() &&
      this.getOidcClientSecret(),
    );
  }
}
