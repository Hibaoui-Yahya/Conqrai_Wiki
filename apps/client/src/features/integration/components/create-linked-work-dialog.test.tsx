import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

/**
 * Create-linked-work dialog.
 *
 * The risks that live only in the client: mutating during a preview, letting a
 * double-click through, rendering a receipt from optimistic state instead of
 * the server's answer, and telling someone to "try again" when the first
 * attempt may well have succeeded.
 */

const previewMutate = vi.fn();
const createMutate = vi.fn();

vi.mock("@/features/integration/queries/integration-query", () => ({
  usePreviewLinkedWorkMutation: () => ({
    mutate: previewMutate,
    isPending: false,
  }),
  useCreateLinkedWorkMutation: () => ({ mutate: createMutate, isPending: false }),
}));
vi.mock("./smart-object-card", () => ({
  SmartObjectCard: ({ model }: { model: { urn: string } }) => (
    <div data-testid="smart-card">{model.urn}</div>
  ),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { CreateLinkedWorkDialog } from "./create-linked-work-dialog";

const requirement = {
  requirementId: "req-1",
  blockId: "block-1",
  urn: "conqr://hub/page/page-1#block=block-1",
  title: "Users can reset their password",
  state: "approved",
  coverage: "uncovered" as const,
  covered: false,
  linkedCount: 0,
  relatedWork: [],
  delivery: [],
};

const preview = {
  requirementUrn: requirement.urn,
  requirementTitle: requirement.title,
  planeProjectId: "proj-1",
  proposed: { title: "Users can reset their password", priority: "high" },
  relationType: "implemented_by",
  idempotencyKey: "req:conqr://hub/page/page-1#block=block-1|project:proj-1",
};

const receipt = {
  status: "created" as const,
  requirementUrn: requirement.urn,
  workItemUrn: "conqr://plane/work-item/wi-1",
  workItemId: "wi-1",
  relationship: {
    relationType: "implemented_by",
    inverseRelationType: "implements",
    id: "rel-1",
  },
  actor: { hubUserId: "user-1" },
  correlationId: "corr-abc",
  idempotencyKey: preview.idempotencyKey,
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <MantineProvider>{children}</MantineProvider>
    </QueryClientProvider>
  );
}

function open() {
  return render(
    <CreateLinkedWorkDialog
      requirement={requirement}
      pageId="page-1"
      planeProjectId="proj-1"
      opened
      onClose={vi.fn()}
    />,
    { wrapper },
  );
}

beforeEach(() => {
  previewMutate.mockReset();
  createMutate.mockReset();
  // Default: preview resolves immediately.
  previewMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.(preview));
});

// ===========================================================================
// 4. Preview performs no mutation
// ===========================================================================

describe("preview", () => {
  it("asks for a preview and creates nothing", async () => {
    open();
    await screen.findByDisplayValue("Users can reset their password");

    expect(previewMutate).toHaveBeenCalledWith(
      expect.objectContaining({ requirementId: "req-1" }),
      expect.anything(),
    );
    // The whole point of a preview step.
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("shows both sides of the boundary and who will act", async () => {
    open();
    await screen.findByDisplayValue("Users can reset their password");

    expect(screen.getByText("Stays in ConqrHub")).toBeInTheDocument();
    expect(screen.getByText("Created in ConqrPlan")).toBeInTheDocument();
    expect(
      screen.getByText("It runs as you, so ConqrPlan applies your own permissions."),
    ).toBeInTheDocument();
  });

  it("warns when work already exists rather than quietly duplicating", async () => {
    previewMutate.mockImplementation((_vars, opts) =>
      opts?.onSuccess?.({
        ...preview,
        existingWork: [{ urn: "conqr://plane/work-item/wi-9", state: "live" }],
      }),
    );
    open();

    expect(
      await screen.findByText("Work already exists for this requirement"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("smart-card")).toBeInTheDocument();
  });

  it("surfaces a missing project mapping in words a user can act on", async () => {
    previewMutate.mockImplementation((_vars, opts) =>
      opts?.onError?.({
        response: { status: 400, data: { message: "no mapped ConqrPlan project" } },
      }),
    );
    open();

    expect(
      await screen.findByText(/isn't connected to a ConqrPlan project/i),
    ).toBeInTheDocument();
    // No raw status codes or backend vocabulary.
    expect(document.body.textContent).not.toContain("400");
  });
});

// ===========================================================================
// 10. Double-click and retry create no duplicates
// ===========================================================================

describe("submission", () => {
  it("sends exactly one create for a double-click", async () => {
    // Never resolves: keeps the request in flight, as a slow network would.
    createMutate.mockImplementation(() => {});
    open();
    const button = await screen.findByRole("button", { name: "Create work item" });

    await userEvent.click(button);
    await userEvent.click(button);
    await userEvent.click(button);

    expect(createMutate).toHaveBeenCalledTimes(1);
  });

  it("disables the button while the write is in flight", async () => {
    createMutate.mockImplementation(() => {});
    open();
    const button = await screen.findByRole("button", { name: "Create work item" });

    await userEvent.click(button);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled(),
    );
  });
});

// ===========================================================================
// 9. Receipt carries authoritative data
// ===========================================================================

describe("receipt", () => {
  it("renders from the server's answer, not optimistic state", async () => {
    createMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.(receipt));
    open();
    await userEvent.click(
      await screen.findByRole("button", { name: "Create work item" }),
    );

    expect(await screen.findByText("Work item created")).toBeInTheDocument();
    expect(screen.getByText("wi-1")).toBeInTheDocument();
    expect(screen.getByText("implemented_by")).toBeInTheDocument();
    expect(screen.getByText(/implements/)).toBeInTheDocument();
    expect(screen.getByText("corr-abc")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Open in ConqrPlan/ }),
    ).toBeInTheDocument();
  });

  it("does not claim a fresh creation when the item already existed", async () => {
    createMutate.mockImplementation((_vars, opts) =>
      opts?.onSuccess?.({ ...receipt, status: "already_exists" }),
    );
    open();
    await userEvent.click(
      await screen.findByRole("button", { name: "Create work item" }),
    );

    expect(
      await screen.findByText("Work already existed — nothing duplicated"),
    ).toBeInTheDocument();
  });

  it("reports a pending link honestly instead of as success", async () => {
    createMutate.mockImplementation((_vars, opts) =>
      opts?.onSuccess?.({
        ...receipt,
        status: "created_link_failed",
        relationship: null,
        warning: "The work item exists but could not be linked.",
      }),
    );
    open();
    await userEvent.click(
      await screen.findByRole("button", { name: "Create work item" }),
    );

    expect(
      await screen.findByText("Work item created, link still pending"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The work item exists but could not be linked."),
    ).toBeInTheDocument();
  });
});

// ===========================================================================
// 11. A delayed response is resolved before retry
// ===========================================================================

describe("indeterminate outcome", () => {
  it("does not offer a blind retry when the outcome is unknown", async () => {
    createMutate.mockImplementation((_vars, opts) =>
      // No response at all: a timeout or a dropped connection.
      opts?.onError?.({ message: "Network Error" }),
    );
    open();
    await userEvent.click(
      await screen.findByRole("button", { name: "Create work item" }),
    );

    expect(await screen.findByText("We couldn't confirm the result")).toBeInTheDocument();
    expect(
      screen.getByText(/may or may not have been created/i),
    ).toBeInTheDocument();
    // The instruction is to look first. "Try again" here is the one piece of
    // advice guaranteed to be wrong half the time.
    expect(screen.getByRole("button", { name: "Close and refresh" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create work item" })).not.toBeInTheDocument();
  });

  it("returns to the form for a definite failure that changed nothing", async () => {
    createMutate.mockImplementation((_vars, opts) =>
      opts?.onError?.({ response: { status: 403 } }),
    );
    open();
    await userEvent.click(
      await screen.findByRole("button", { name: "Create work item" }),
    );

    expect(
      await screen.findByText(/ConqrPlan turned this down/i),
    ).toBeInTheDocument();
    // Safe to correct and resubmit: nothing was created.
    expect(screen.getByRole("button", { name: "Create work item" })).toBeEnabled();
  });

  it("says nothing was changed when ConqrPlan is unavailable", async () => {
    createMutate.mockImplementation((_vars, opts) =>
      opts?.onError?.({ response: { status: 503 } }),
    );
    open();
    await userEvent.click(
      await screen.findByRole("button", { name: "Create work item" }),
    );

    expect(
      await screen.findByText(/temporarily unavailable. Nothing was changed/i),
    ).toBeInTheDocument();
  });
});
