import { Box, Divider, ScrollArea, Text } from "@mantine/core";
import CommentListWithTabs from "@/features/comment/components/comment-list-with-tabs.tsx";
import { useAtom } from "jotai";
import { asideStateAtom } from "@/components/layouts/global/hooks/atoms/sidebar-atom.ts";
import React, { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { TableOfContents } from "@/features/editor/components/table-of-contents/table-of-contents.tsx";
import { useAtomValue } from "jotai";
import { pageEditorAtom } from "@/features/editor/atoms/editor-atoms.ts";
import AsideChatPanel from "@/ee/ai-chat/components/aside-chat-panel";
import { useParams } from "react-router-dom";
import { extractPageSlugId } from "@/lib";
import { usePageQuery } from "@/features/page/queries/page-query.ts";
import { useSpaceMappings } from "@/features/integration/queries/integration-query.ts";
import { RequirementDeliveryPanel } from "@/features/integration/components/requirement-delivery-panel";
import { KnowledgePanel } from "@/features/integration/components/knowledge-panel.tsx";
import PageAttachmentsPanel from "@/features/attachments/components/page-attachments-panel.tsx";

export default function Aside() {
  const [{ tab }] = useAtom(asideStateAtom);
  const { t } = useTranslation();
  const pageEditor = useAtomValue(pageEditorAtom);

  const { pageSlug } = useParams();
  const slugId = extractPageSlugId(pageSlug);
  const { data: currentPage } = usePageQuery({ pageId: slugId });
  const { data: spaceMappings } = useSpaceMappings(
    tab === "links" ? currentPage?.spaceId : undefined,
  );
  // Prefer the space's primary Plane project, else fall back to the first
  // mapping — mirrors the server's resolveSpacePlaneTarget so a space mapped
  // only as a secondary docs space still resolves work items (§8.3).
  const mappedProjectId =
    spaceMappings?.find((m) => m.mappingKind === "primary")?.planeProjectId ??
    spaceMappings?.[0]?.planeProjectId;

  let title: string;
  let component: ReactNode;

  switch (tab) {
    case "comments":
      component = <CommentListWithTabs />;
      title = "Comments";
      break;
    case "toc":
      component = <TableOfContents editor={pageEditor} />;
      title = "Table of contents";
      break;
    case "chat":
      component = <AsideChatPanel />;
      title = "AI Chat";
      break;
    case "attachments":
      component = <PageAttachmentsPanel pageId={currentPage?.id} />;
      title = "Attachments";
      break;
    case "links":
      // Requirements first: they are the unit delivery is tracked against, and
      // the general link graph below is context for them rather than a peer.
      // Both live in the same tab so there is one place to look for "what is
      // connected to this page".
      component = currentPage?.id ? (
        <>
          <RequirementDeliveryPanel
            pageId={currentPage.id}
            planeProjectId={mappedProjectId}
          />
          <Divider my="md" color="var(--border-subtle)" />
          <KnowledgePanel
            urn={`conqr://hub/page/${currentPage.id}`}
            planeProjectId={mappedProjectId}
          />
        </>
      ) : null;
      title = "Related work & knowledge";
      break;
    default:
      component = null;
      title = null;
  }

  return (
    <Box p="md" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {component && (
        <>
          {tab !== "chat" && (
            <Text mb="md" fw={500}>
              {t(title)}
            </Text>
          )}

          {tab === "comments" || tab === "chat" ? (
            component
          ) : (
            <ScrollArea
              style={{ height: "85vh" }}
              scrollbarSize={5}
              type="scroll"
            >
              <div style={{ paddingBottom: "200px" }}>{component}</div>
            </ScrollArea>
          )}
        </>
      )}
    </Box>
  );
}
