import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Paper,
  Skeleton,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleDashed,
  IconLock,
  IconPlus,
  IconRefresh,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@conqr/ui";
import { AccessibleIcon } from "@conqr/icons";
import { usePageRequirements } from "@/features/integration/queries/integration-query";
import { useIntegrationEvents } from "@/features/integration/queries/use-integration-events";
import {
  CoverageState,
  RequirementCoverage,
} from "@/features/integration/types/integration.types";
import { SmartObjectCard } from "./smart-object-card";
import { CreateLinkedWorkDialog } from "./create-linked-work-dialog";

/**
 * Related Work: requirements on this page and the delivery behind them.
 *
 * Adapted from the knowledge panel rather than built beside it — same
 * resolution hook, same smart-object cards, same live-refresh subscription, so
 * a ConqrPlan work item looks and behaves identically wherever it appears.
 * What this adds is the requirement as the organising unit: work is grouped by
 * what it implements, not by which product it came from.
 *
 * The panel answers four questions at a glance: what is required, whether
 * execution exists, what state it is in, and whether what you are looking at
 * is current.
 */
export function RequirementDeliveryPanel({
  pageId,
  planeProjectId,
}: {
  pageId: string;
  planeProjectId?: string;
}) {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch, isFetching } = usePageRequirements(
    pageId,
    planeProjectId,
  );
  // Live delivery updates: a ConqrPlan state change invalidates this query.
  useIntegrationEvents();

  const [target, setTarget] = useState<RequirementCoverage | null>(null);

  const summary = data?.summary;
  const items = useMemo(() => data?.items ?? [], [data]);

  if (isLoading) {
    return (
      <Stack gap="sm" p="sm" aria-busy="true" aria-live="polite">
        <Text size="sm" c="var(--txt-tertiary)">
          {t("Loading requirements…")}
        </Text>
        {/* Fixed-height skeletons matching the real rows, so nothing jumps
            when the data lands. */}
        <Skeleton height={72} radius="sm" />
        <Skeleton height={72} radius="sm" />
      </Stack>
    );
  }

  if (isError) {
    return (
      <Alert
        color="red"
        variant="light"
        radius="sm"
        m="sm"
        icon={<IconAlertTriangle size={16} />}
      >
        <Stack gap="xs">
          <Text size="sm">{t("Couldn't load requirements for this page.")}</Text>
          <Button size="xs" variant="light" onClick={() => refetch()}>
            {t("Try again")}
          </Button>
        </Stack>
      </Alert>
    );
  }

  if (!items.length) {
    return (
      <Stack gap="sm" p="sm">
        <EmptyState
          icon={<AccessibleIcon name="relation" label={t("Requirements")} size={20} />}
          title={t("No requirements on this page yet")}
          description={t(
            "Select text in the page and choose “Mark as requirement” to start tracking delivery against it.",
          )}
        />
      </Stack>
    );
  }

  return (
    <Stack gap="md" p="xs">
      <CoverageHeader summary={summary} refreshing={isFetching} onRefresh={refetch} />

      <Stack gap="sm" component="ul" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {items.map((req) => (
          <RequirementRow
            key={req.requirementId}
            requirement={req}
            canCreate={Boolean(planeProjectId)}
            onCreate={() => setTarget(req)}
          />
        ))}
      </Stack>

      <CreateLinkedWorkDialog
        requirement={target}
        pageId={pageId}
        planeProjectId={planeProjectId}
        opened={Boolean(target)}
        onClose={() => setTarget(null)}
      />
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function CoverageHeader({
  summary,
  refreshing,
  onRefresh,
}: {
  summary?: {
    total: number;
    approvedOrBeyond: number;
    covered: number;
    uncovered: number;
    provisional: number;
    unresolvedSources: string[];
  };
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  if (!summary) return null;

  return (
    <Stack gap="xs">
      <Group justify="space-between" wrap="nowrap">
        <Text size="xs" fw={600} tt="uppercase" c="var(--txt-tertiary)">
          {t("Delivery coverage")}
        </Text>
        <Tooltip label={t("Refresh delivery status")}>
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={onRefresh}
            aria-label={t("Refresh delivery status")}
          >
            {refreshing ? <Loader size={12} /> : <IconRefresh size={14} />}
          </Button>
        </Tooltip>
      </Group>
      <Group gap="xs" wrap="wrap">
        <Badge size="sm" variant="light" color="green">
          {t("{{n}} covered", { n: summary.covered })}
        </Badge>
        <Badge size="sm" variant="light" color="gray">
          {t("{{n}} uncovered", { n: summary.uncovered })}
        </Badge>
        {summary.provisional > 0 && (
          <Badge size="sm" variant="light" color="yellow">
            {t("{{n}} provisional", { n: summary.provisional })}
          </Badge>
        )}
      </Group>
      {summary.unresolvedSources.length > 0 && (
        <Text size="xs" c="var(--txt-tertiary)">
          {t(
            "Some delivery status couldn't be confirmed just now. Showing the last known state.",
          )}
        </Text>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function RequirementRow({
  requirement,
  canCreate,
  onCreate,
}: {
  requirement: RequirementCoverage;
  canCreate: boolean;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
  const staleCount = requirement.delivery.filter((d) => d.stale).length;
  const lastSync = mostRecentSync(requirement);

  // Offered only when there is nothing to duplicate and somewhere to put it.
  const showCreate =
    canCreate &&
    (requirement.coverage === "uncovered" ||
      requirement.coverage === "provisional");

  return (
    <Paper
      component="li"
      withBorder
      radius="sm"
      p="sm"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      <Stack gap="xs">
        {/* The requirement text is the row's subject, so it gets the full
            width and wraps. An earlier layout put the action beside it and the
            title clamped to "Get account…", which made the panel unreadable
            for anything but very short requirements. */}
        <Text size="sm" fw={500} style={{ wordBreak: "break-word" }}>
          {requirement.title ?? t("Untitled requirement")}
        </Text>

        <Group gap={6} wrap="wrap" justify="space-between" align="center">
          <Group gap={6} wrap="wrap">
            <Badge size="xs" variant="default" tt="capitalize">
              {requirement.state}
            </Badge>
            <CoverageBadge
              coverage={requirement.coverage}
              linkedCount={requirement.linkedCount}
            />
          </Group>
          {showCreate && (
            <Button
              size="compact-xs"
              variant="light"
              leftSection={<IconPlus size={12} />}
              onClick={onCreate}
            >
              {t("Create linked work")}
            </Button>
          )}
        </Group>

        {requirement.relatedWork.length > 0 && (
          <Stack gap="xs">
            {/* Grouped by what the relationship means, not by product. */}
            <Text size="xs" fw={600} tt="uppercase" c="var(--txt-tertiary)">
              {t("Implemented by")}
            </Text>
            {requirement.relatedWork.map((model) => (
              <SmartObjectCard key={model.urn} model={model} />
            ))}
          </Stack>
        )}

        {(staleCount > 0 || lastSync) && (
          <Group gap={6} wrap="nowrap">
            {staleCount > 0 && (
              <Tooltip
                label={t(
                  "ConqrPlan hasn't confirmed this recently. It refreshes automatically.",
                )}
              >
                <Badge size="xs" variant="light" color="yellow">
                  {t("Not confirmed recently")}
                </Badge>
              </Tooltip>
            )}
            {lastSync && (
              <Text size="xs" c="var(--txt-tertiary)">
                {t("Synced")} {formatSync(lastSync)}
              </Text>
            )}
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

// ---------------------------------------------------------------------------

function CoverageBadge({
  coverage,
  linkedCount,
}: {
  coverage: CoverageState;
  linkedCount: number;
}) {
  const { t } = useTranslation();

  switch (coverage) {
    case "covered":
      return (
        <Badge
          size="xs"
          variant="light"
          color="green"
          leftSection={<IconCircleCheck size={11} />}
        >
          {t("Covered")}
          {linkedCount > 1 ? ` · ${linkedCount}` : ""}
        </Badge>
      );
    case "provisional":
      return (
        <Tooltip
          label={t(
            "Something is linked, but we couldn't confirm it delivers this requirement.",
          )}
        >
          <Badge
            size="xs"
            variant="light"
            color="yellow"
            leftSection={<IconAlertTriangle size={11} />}
          >
            {t("Provisional")}
          </Badge>
        </Tooltip>
      );
    case "all_restricted":
      // Neither covered nor plainly uncovered: work exists and this person
      // cannot verify any of it. Says nothing about what, where or how much.
      return (
        <Tooltip
          label={t(
            "Work is linked here, but you don't have access to it. Ask the project owner if you need visibility.",
          )}
        >
          <Badge
            size="xs"
            variant="light"
            color="gray"
            leftSection={<IconLock size={11} />}
          >
            {t("Uncovered for you")}
          </Badge>
        </Tooltip>
      );
    default:
      return (
        <Badge
          size="xs"
          variant="light"
          color="gray"
          leftSection={<IconCircleDashed size={11} />}
        >
          {t("Uncovered")}
        </Badge>
      );
  }
}

function mostRecentSync(requirement: RequirementCoverage): string | null {
  const stamps = requirement.delivery
    .map((d) => d.lastSyncedAt)
    .filter((s): s is string => Boolean(s))
    .sort();
  return stamps.length ? stamps[stamps.length - 1] : null;
}

function formatSync(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
