import { useEffect, useRef, useState } from "react";
import { useAtom } from "jotai";
import { useParams } from "react-router-dom";
import {
  Alert,
  Button,
  Group,
  Modal,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { extractPageSlugId } from "@/lib";
import { usePageQuery } from "@/features/page/queries/page-query.ts";
import { useRegisterRequirementMutation } from "@/features/integration/queries/integration-query";
import { markRequirementDraftAtom } from "@/features/integration/atoms/mark-requirement-atom";

/**
 * "Mark as requirement" — the smallest native authoring path.
 *
 * Mirrors `create-work-item-from-selection`: the bubble menu contributes the
 * selected text, this page-scoped host contributes the page and calls the
 * existing `requirements/register` endpoint. The editor's schema, serialisation
 * and behaviour are untouched, which is deliberate — a requirement mark stored
 * in the document would be a change to the collaborative content model, and
 * that is a far larger commitment than this slice is allowed to make.
 *
 * **The trade-off, stated plainly.** With no anchor in the document, the
 * requirement's stable id is derived from its text. Marking the same sentence
 * twice is therefore idempotent (the backend upserts on page + block id), but
 * *editing* the sentence later produces a new requirement rather than renaming
 * the existing one. That is the known limitation of authoring without an
 * editor mark, and closing it is the first thing the next phase should do.
 */
export function MarkRequirementFromSelection() {
  const { t } = useTranslation();
  const [draft, setDraft] = useAtom(markRequirementDraftAtom);
  const { pageSlug } = useParams();
  const slugId = extractPageSlugId(pageSlug);
  const { data: page } = usePageQuery({ pageId: slugId });
  const register = useRegisterRequirementMutation(page?.id);

  const [title, setTitle] = useState("");
  const submitting = useRef(false);

  useEffect(() => {
    if (draft.open) {
      setTitle(draft.title);
      submitting.current = false;
    }
  }, [draft.open, draft.title]);

  const close = () => setDraft({ open: false, title: "" });

  const submit = () => {
    const value = title.trim();
    if (!page?.id || !value || submitting.current) return;
    submitting.current = true;

    register.mutate(
      { pageId: page.id, blockId: blockIdFor(value), title: value },
      {
        onSuccess: () => {
          notifications.show({
            message: t("Tracked as a requirement"),
          });
          close();
        },
        onError: () => {
          submitting.current = false;
          notifications.show({
            color: "red",
            message: t("Couldn't track this as a requirement."),
          });
        },
      },
    );
  };

  if (!page?.id) return null;

  return (
    <Modal
      opened={draft.open}
      onClose={close}
      title={t("Mark as requirement")}
      size="md"
      trapFocus
    >
      <Stack gap="md">
        <TextInput
          label={t("Requirement")}
          description={t("This is what delivery will be tracked against.")}
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          data-autofocus
          required
        />
        <Alert variant="light" color="blue" icon={<IconInfoCircle size={16} />}>
          <Text size="sm">
            {t(
              "It starts as a draft and appears in Related Work, where you can create the delivery work for it.",
            )}
          </Text>
        </Alert>
        <Group justify="flex-end">
          <Button variant="default" onClick={close} disabled={register.isPending}>
            {t("Cancel")}
          </Button>
          <Button
            onClick={submit}
            loading={register.isPending}
            disabled={register.isPending || !title.trim()}
          >
            {t("Mark as requirement")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/**
 * A stable id for a requirement, derived from its text.
 *
 * Deterministic so that marking the same sentence twice upserts rather than
 * creating a duplicate identity — which is the one duplication risk this path
 * can actually prevent without an anchor in the document.
 */
function blockIdFor(title: string): string {
  const normalized = title.toLowerCase().replace(/\s+/g, " ").trim();
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `req-${(hash >>> 0).toString(36)}`;
}
