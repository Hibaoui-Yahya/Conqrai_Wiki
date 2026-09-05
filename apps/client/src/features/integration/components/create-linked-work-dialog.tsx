import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  CopyButton,
  Divider,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  TextInput,
  Textarea,
  Select,
  ThemeIcon,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheck,
  IconExternalLink,
  IconInfoCircle,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  useCreateLinkedWorkMutation,
  usePreviewLinkedWorkMutation,
} from "@/features/integration/queries/integration-query";
import {
  LinkedWorkPreview,
  LinkedWorkReceipt,
  RequirementCoverage,
} from "@/features/integration/types/integration.types";
import { SmartObjectCard } from "./smart-object-card";

/**
 * Create-linked-work: preview → confirm → receipt.
 *
 * The lifecycle is deliberately three visible steps rather than one button,
 * because this mutation reaches into another product and ConqrHub cannot undo
 * it. Removing the relationship afterwards does not delete the ConqrPlan work
 * item, and it should not — ConqrHub does not own that work. So the user sees
 * what will happen, where it will happen, and as whom, before it happens.
 *
 * The receipt is rendered from the server's response, never from optimistic
 * client state: the whole point of a receipt is that it records what the
 * authoritative system actually did.
 */

type Phase = "preview" | "submitting" | "receipt" | "unknown";

export function CreateLinkedWorkDialog({
  requirement,
  pageId,
  planeProjectId,
  opened,
  onClose,
}: {
  requirement: RequirementCoverage | null;
  pageId?: string;
  planeProjectId?: string;
  opened: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const previewMutation = usePreviewLinkedWorkMutation();
  const createMutation = useCreateLinkedWorkMutation(pageId);

  const [phase, setPhase] = useState<Phase>("preview");
  const [preview, setPreview] = useState<LinkedWorkPreview | null>(null);
  const [receipt, setReceipt] = useState<LinkedWorkReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Editable fields, seeded from the preview.
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<string | null>(null);

  /**
   * Guards the submit against a second in-flight request.
   *
   * A ref rather than state because a double-click fires both handlers before
   * React re-renders, so a state flag would not have flipped yet and both
   * would pass the check.
   */
  const submitting = useRef(false);

  useEffect(() => {
    if (!opened || !requirement) return;
    setPhase("preview");
    setPreview(null);
    setReceipt(null);
    setError(null);
    submitting.current = false;

    previewMutation.mutate(
      { requirementId: requirement.requirementId, planeProjectId },
      {
        onSuccess: (data) => {
          setPreview(data);
          setTitle(data.proposed.title);
          setDescription(stripHtml(data.proposed.descriptionHtml ?? ""));
          setPriority(data.proposed.priority ?? null);
        },
        onError: (err) => setError(friendlyError(err, t)),
      },
    );
    // Re-previewing on every keystroke would make a cross-product call per
    // character; this intentionally runs once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, requirement?.requirementId]);

  const confirm = () => {
    if (!requirement || submitting.current) return;
    submitting.current = true;
    setPhase("submitting");
    setError(null);

    createMutation.mutate(
      {
        requirementId: requirement.requirementId,
        planeProjectId,
        title: title.trim(),
        descriptionHtml: description.trim()
          ? `<p>${escapeHtml(description.trim())}</p>`
          : undefined,
        priority: priority ?? undefined,
      },
      {
        onSuccess: (data) => {
          setReceipt(data);
          setPhase("receipt");
          submitting.current = false;
        },
        onError: (err) => {
          // A failed request is not proof that nothing was created — the write
          // may have committed and the response been lost. Say so rather than
          // inviting a retry that could duplicate work.
          const unknown = isIndeterminate(err);
          setError(friendlyError(err, t));
          setPhase(unknown ? "unknown" : "preview");
          submitting.current = false;
        },
      },
    );
  };

  const close = () => {
    if (phase === "submitting") return; // never abandon an in-flight write
    onClose();
  };

  return (
    <Modal
      opened={opened}
      onClose={close}
      title={modalTitle(phase, t)}
      size="lg"
      closeOnClickOutside={phase !== "submitting"}
      closeOnEscape={phase !== "submitting"}
      trapFocus
    >
      {phase === "receipt" && receipt ? (
        <Receipt receipt={receipt} onClose={onClose} />
      ) : phase === "unknown" ? (
        <IndeterminateOutcome message={error} onClose={onClose} />
      ) : (
        <PreviewBody
          requirement={requirement}
          preview={preview}
          loading={previewMutation.isPending}
          error={error}
          phase={phase}
          title={title}
          setTitle={setTitle}
          description={description}
          setDescription={setDescription}
          priority={priority}
          setPriority={setPriority}
          onConfirm={confirm}
          onCancel={close}
        />
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

function PreviewBody({
  requirement,
  preview,
  loading,
  error,
  phase,
  title,
  setTitle,
  description,
  setDescription,
  priority,
  setPriority,
  onConfirm,
  onCancel,
}: any) {
  const { t } = useTranslation();
  const busy = phase === "submitting";

  if (loading) {
    return (
      <Group gap="xs" py="lg" justify="center">
        <Loader size="sm" />
        <Text size="sm" c="var(--txt-tertiary)">
          {t("Preparing preview…")}
        </Text>
      </Group>
    );
  }

  if (error && !preview) {
    return (
      <Stack gap="md">
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
          {error}
        </Alert>
        <Group justify="flex-end">
          <Button variant="default" onClick={onCancel}>
            {t("Close")}
          </Button>
        </Group>
      </Stack>
    );
  }

  if (!preview) return null;

  return (
    <Stack gap="md">
      {error && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
          {error}
        </Alert>
      )}

      {/* What links to what, and which side owns which half. */}
      <Group gap="sm" wrap="nowrap" align="center">
        <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
          <Text size="xs" c="var(--txt-tertiary)" tt="uppercase" fw={600}>
            {t("Requirement")}
          </Text>
          <Text size="sm" fw={500} lineClamp={2}>
            {preview.requirementTitle ?? requirement?.title ?? t("Untitled")}
          </Text>
          <Text size="xs" c="var(--txt-tertiary)">
            {t("Stays in ConqrHub")}
          </Text>
        </Stack>
        <ThemeIcon variant="light" size="sm" radius="xl" aria-hidden>
          <IconArrowRight size={14} />
        </ThemeIcon>
        <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
          <Text size="xs" c="var(--txt-tertiary)" tt="uppercase" fw={600}>
            {t("New work item")}
          </Text>
          <Text size="sm" fw={500} lineClamp={2}>
            {title || t("Untitled")}
          </Text>
          <Text size="xs" c="var(--txt-tertiary)">
            {t("Created in ConqrPlan")}
          </Text>
        </Stack>
      </Group>

      <Divider />

      {preview.existingWork?.length ? (
        <Alert
          color="yellow"
          variant="light"
          icon={<IconInfoCircle size={16} />}
          title={t("Work already exists for this requirement")}
        >
          <Stack gap="xs" mt="xs">
            {preview.existingWork.map((m: any) => (
              <SmartObjectCard key={m.urn} model={m} />
            ))}
          </Stack>
        </Alert>
      ) : null}

      <TextInput
        label={t("Work item name")}
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        disabled={busy}
        required
        data-autofocus
      />
      <Textarea
        label={t("Context")}
        description={t("Copied into ConqrPlan. The requirement itself stays here.")}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
        disabled={busy}
        autosize
        minRows={2}
        maxRows={5}
      />
      <Select
        label={t("Priority")}
        value={priority}
        onChange={setPriority}
        disabled={busy}
        clearable
        data={[
          { value: "urgent", label: t("Urgent") },
          { value: "high", label: t("High") },
          { value: "medium", label: t("Medium") },
          { value: "low", label: t("Low") },
          { value: "none", label: t("None") },
        ]}
      />

      <Alert variant="light" color="blue" icon={<IconInfoCircle size={16} />}>
        <Stack gap={4}>
          <Text size="sm">
            {t(
              "This creates one work item in ConqrPlan and records a link back to this requirement.",
            )}
          </Text>
          <Text size="xs" c="var(--txt-tertiary)">
            {t("It runs as you, so ConqrPlan applies your own permissions.")}
          </Text>
        </Stack>
      </Alert>

      <Group justify="flex-end">
        <Button variant="default" onClick={onCancel} disabled={busy}>
          {t("Cancel")}
        </Button>
        <Button
          onClick={onConfirm}
          loading={busy}
          disabled={busy || !title.trim()}
        >
          {busy ? t("Creating…") : t("Create work item")}
        </Button>
      </Group>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

function Receipt({
  receipt,
  onClose,
}: {
  receipt: LinkedWorkReceipt;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const partial = receipt.status === "created_link_failed";

  return (
    <Stack gap="md">
      <Group gap="sm">
        <ThemeIcon
          color={partial ? "yellow" : "green"}
          variant="light"
          radius="xl"
          aria-hidden
        >
          {partial ? <IconAlertTriangle size={16} /> : <IconCheck size={16} />}
        </ThemeIcon>
        <Text fw={600}>
          {partial
            ? t("Work item created, link still pending")
            : receipt.status === "already_exists"
              ? t("Work already existed — nothing duplicated")
              : t("Work item created")}
        </Text>
      </Group>

      {partial && receipt.warning && (
        <Alert color="yellow" variant="light">
          {receipt.warning}
        </Alert>
      )}

      <Stack gap="xs">
        <ReceiptRow label={t("Work item")} value={receipt.workItemId} />
        {receipt.relationship && (
          <ReceiptRow
            label={t("Relationship")}
            value={
              <Group gap={6}>
                <Badge size="sm" variant="light">
                  {receipt.relationship.relationType}
                </Badge>
                <Text size="xs" c="var(--txt-tertiary)">
                  {t("inverse")}: {receipt.relationship.inverseRelationType}
                </Text>
              </Group>
            }
          />
        )}
        <ReceiptRow label={t("Created by")} value={t("You")} />
        <ReceiptRow
          label={t("Reference")}
          value={
            <Group gap={6} wrap="nowrap">
              <Code>{receipt.correlationId}</Code>
              <CopyButton value={receipt.correlationId}>
                {({ copied, copy }) => (
                  <Button size="compact-xs" variant="subtle" onClick={copy}>
                    {copied ? t("Copied") : t("Copy")}
                  </Button>
                )}
              </CopyButton>
            </Group>
          }
        />
      </Stack>

      <Group justify="space-between">
        <Anchor
          href={planeDeepLink(receipt)}
          target="_blank"
          rel="noreferrer noopener"
          size="sm"
        >
          <Group gap={4}>
            <IconExternalLink size={14} />
            {t("Open in ConqrPlan")}
          </Group>
        </Anchor>
        <Button onClick={onClose}>{t("Done")}</Button>
      </Group>
    </Stack>
  );
}

function ReceiptRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Group gap="xs" align="flex-start" wrap="nowrap">
      <Text size="xs" c="var(--txt-tertiary)" w={110} style={{ flexShrink: 0 }}>
        {label}
      </Text>
      {typeof value === "string" ? <Text size="sm">{value}</Text> : value}
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Indeterminate outcome
// ---------------------------------------------------------------------------

/**
 * The response was lost, so we do not know whether the write landed.
 *
 * Offering "try again" here would be the one piece of advice guaranteed to be
 * wrong half the time: if the create did succeed, a retry is how you end up
 * with two work items for one requirement. The backend's idempotency key would
 * in fact catch it, but the user should not have to know that — the honest
 * instruction is to look before acting.
 */
function IndeterminateOutcome({
  message,
  onClose,
}: {
  message: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Stack gap="md">
      <Alert
        color="yellow"
        variant="light"
        icon={<IconAlertTriangle size={16} />}
        title={t("We couldn't confirm the result")}
      >
        <Stack gap="xs">
          <Text size="sm">
            {t(
              "The request to ConqrPlan didn't come back in time. The work item may or may not have been created.",
            )}
          </Text>
          <Text size="sm">
            {t(
              "Close this and refresh the panel. If the work item is there, you're done. If it isn't, you can try again safely.",
            )}
          </Text>
          {message && (
            <Text size="xs" c="var(--txt-tertiary)">
              {message}
            </Text>
          )}
        </Stack>
      </Alert>
      <Group justify="flex-end">
        <Button onClick={onClose}>{t("Close and refresh")}</Button>
      </Group>
    </Stack>
  );
}

// ---------------------------------------------------------------------------

function modalTitle(phase: Phase, t: (k: string) => string) {
  if (phase === "receipt") return t("Linked work created");
  if (phase === "unknown") return t("Outcome unknown");
  return t("Create linked work");
}

/** A timeout or network drop leaves the outcome genuinely unknown. */
function isIndeterminate(err: any): boolean {
  const status = err?.response?.status;
  if (status === undefined) return true; // no response at all
  return status === 408 || status === 504 || status === 502;
}

/**
 * Map a failure onto something a user can act on.
 *
 * Deliberately free of status codes, URNs and stack traces: those belong in
 * the correlation id, which support can trace, not in the sentence someone
 * reads while trying to get their work planned.
 */
function friendlyError(err: any, t: (k: string) => string): string {
  const status = err?.response?.status;
  const code = err?.response?.data?.code;

  if (status === 401 || code === "PERMISSION_DENIED") {
    return t("You don't have permission to create work in this project.");
  }
  if (status === 403) {
    return t("ConqrPlan turned this down. Your access may have changed.");
  }
  if (code === "NO_PROJECT_MAPPING" || /no mapped/i.test(err?.response?.data?.message ?? "")) {
    return t(
      "This page's space isn't connected to a ConqrPlan project yet. An admin can set that up in space settings.",
    );
  }
  if (status === 409) {
    return t("Work already exists for this requirement.");
  }
  if (status >= 500) {
    return t("ConqrPlan is temporarily unavailable. Nothing was changed.");
  }
  return t("Something went wrong and no work item was created.");
}

function planeDeepLink(receipt: LinkedWorkReceipt): string {
  // The resolver supplies real deep links on cards; the receipt only knows the
  // id, so this is a best-effort relative link the app rewrites.
  return `/api/integrations/work-items/${receipt.workItemId}/open`;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
