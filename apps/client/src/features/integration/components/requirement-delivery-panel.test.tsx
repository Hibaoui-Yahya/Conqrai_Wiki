import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

/**
 * Related Work panel — UI state matrix and permission behaviour.
 *
 * The coverage rules themselves are decided and tested on the server; what is
 * tested here is the thing only the UI can get wrong: rendering a state as
 * something it is not, or putting protected metadata on screen.
 */

const mockUsePageRequirements = vi.fn();

vi.mock("@/features/integration/queries/integration-query", () => ({
  usePageRequirements: (...args: unknown[]) => mockUsePageRequirements(...args),
  usePreviewLinkedWorkMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateLinkedWorkMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/features/integration/queries/use-integration-events", () => ({
  useIntegrationEvents: vi.fn(),
}));
vi.mock("@conqr/ui", () => ({
  EmptyState: ({ title, description }: { title: string; description: string }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  ),
}));
vi.mock("@conqr/icons", () => ({
  AccessibleIcon: ({ label }: { label: string }) => <span aria-hidden>{label}</span>,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // Mirrors i18next interpolation so count strings are asserted as rendered.
    t: (key: string, vars?: Record<string, unknown>) =>
      vars
        ? key.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ""))
        : key,
  }),
}));

import { RequirementDeliveryPanel } from "./requirement-delivery-panel";

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

const requirement = (over: Record<string, unknown> = {}) => ({
  requirementId: "req-1",
  blockId: "block-1",
  urn: "conqr://hub/page/page-1#block=block-1",
  title: "Users can reset their password",
  state: "approved",
  coverage: "uncovered",
  covered: false,
  linkedCount: 0,
  relatedWork: [],
  delivery: [],
  ...over,
});

const summary = (over: Record<string, unknown> = {}) => ({
  total: 1,
  approvedOrBeyond: 1,
  covered: 0,
  uncovered: 1,
  provisional: 0,
  unresolvedSources: [],
  gaps: [],
  ...over,
});

function setup(state: Record<string, unknown>) {
  mockUsePageRequirements.mockReturnValue({
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
    ...state,
  });
  return render(
    <RequirementDeliveryPanel pageId="page-1" planeProjectId="proj-1" />,
    { wrapper },
  );
}

beforeEach(() => mockUsePageRequirements.mockReset());

// ===========================================================================
// State matrix
// ===========================================================================

describe("panel states", () => {
  it("shows a loading state without collapsing the layout", () => {
    setup({ isLoading: true, data: undefined });
    const region = screen.getByText("Loading requirements…").closest("[aria-busy]");
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(region).toHaveAttribute("aria-live", "polite");
  });

  it("shows a recoverable error with a retry", async () => {
    const refetch = vi.fn();
    setup({ isError: true, data: undefined, refetch });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("shows an empty state that explains how to author a requirement", () => {
    setup({ data: { items: [], summary: summary({ total: 0, uncovered: 0 }) } });
    expect(screen.getByText("No requirements on this page yet")).toBeInTheDocument();
    expect(screen.getByText(/Mark as requirement/)).toBeInTheDocument();
  });

  it("renders an uncovered requirement with a create action", () => {
    setup({ data: { items: [requirement()], summary: summary() } });
    expect(screen.getByText("Users can reset their password")).toBeInTheDocument();
    expect(screen.getByText("Uncovered")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create linked work" }),
    ).toBeInTheDocument();
  });

  it("renders a covered requirement and withdraws the create action", () => {
    setup({
      data: {
        items: [
          requirement({
            coverage: "covered",
            covered: true,
            linkedCount: 1,
            relatedWork: [
              {
                urn: "conqr://plane/work-item/wi-1",
                state: "live",
                title: "Implement password reset",
                fields: { state: "In Progress" },
              },
            ],
            delivery: [
              {
                urn: "conqr://plane/work-item/wi-1",
                origin: "live",
                stale: false,
                lastSyncedAt: new Date().toISOString(),
              },
            ],
          }),
        ],
        summary: summary({ covered: 1, uncovered: 0 }),
      },
    });

    expect(screen.getByText("Covered")).toBeInTheDocument();
    expect(screen.getByText("Implemented by")).toBeInTheDocument();
    // Nothing to create: offering it again invites a duplicate.
    expect(
      screen.queryByRole("button", { name: "Create linked work" }),
    ).not.toBeInTheDocument();
  });

  it("renders provisional distinctly from covered", () => {
    setup({
      data: {
        items: [
          requirement({
            coverage: "provisional",
            linkedCount: 1,
            relatedWork: [
              { urn: "conqr://plane/work-item/wi-1", state: "source_unavailable" },
            ],
            delivery: [
              {
                urn: "conqr://plane/work-item/wi-1",
                origin: "unavailable",
                stale: true,
                lastSyncedAt: null,
              },
            ],
          }),
        ],
        summary: summary({ uncovered: 0, provisional: 1 }),
      },
    });

    expect(screen.getByText("Provisional")).toBeInTheDocument();
    expect(screen.queryByText("Covered")).not.toBeInTheDocument();
    // Still actionable: something is linked but may deliver nothing.
    expect(
      screen.getByRole("button", { name: "Create linked work" }),
    ).toBeInTheDocument();
  });

  it("labels a stale projection rather than passing it off as current", () => {
    setup({
      data: {
        items: [
          requirement({
            coverage: "covered",
            covered: true,
            linkedCount: 1,
            relatedWork: [
              {
                urn: "conqr://plane/work-item/wi-1",
                state: "stale",
                title: "Implement password reset",
                fields: { state: "In Progress" },
              },
            ],
            delivery: [
              {
                urn: "conqr://plane/work-item/wi-1",
                origin: "projection",
                stale: true,
                lastSyncedAt: "2026-09-04T09:00:00.000Z",
              },
            ],
          }),
        ],
        summary: summary({ covered: 1, uncovered: 0 }),
      },
    });

    expect(screen.getByText("Not confirmed recently")).toBeInTheDocument();
    expect(screen.getByText(/Synced/)).toBeInTheDocument();
  });

  it("says so when delivery status could not be confirmed at all", () => {
    setup({
      data: {
        items: [requirement()],
        summary: summary({
          unresolvedSources: ["conqr://plane/work-item/wi-9"],
        }),
      },
    });
    expect(
      screen.getByText(/couldn't be confirmed just now/i),
    ).toBeInTheDocument();
  });
});

// ===========================================================================
// 17 & 18. Permission shaping
// ===========================================================================

describe("permission-restricted work", () => {
  const restricted = {
    data: {
      items: [
        requirement({
          coverage: "all_restricted",
          covered: false,
          linkedCount: 1,
          relatedWork: [
            { urn: "conqr://plane/work-item/wi-secret", state: "restricted" },
          ],
          delivery: [
            {
              urn: "conqr://plane/work-item/wi-secret",
              origin: "live",
              stale: false,
              lastSyncedAt: null,
            },
          ],
        }),
      ],
      summary: summary({ uncovered: 0 }),
    },
  };

  it('renders all_restricted as "Uncovered for you"', () => {
    setup(restricted);
    expect(screen.getByText("Uncovered for you")).toBeInTheDocument();
    // Never the plain covered badge: the viewer cannot verify anything.
    expect(screen.queryByText("Covered")).not.toBeInTheDocument();
  });

  it("leaks no title, project, assignee or status for restricted work", () => {
    setup(restricted);

    // Everything the panel put on screen, checked as one string. What must
    // never appear is anything that identifies the work: its id, its title,
    // its project, its state or an assignee.
    //
    // The relationship label ("Implemented by") deliberately does appear. It
    // describes the requirement's own graph, which the viewer is entitled to,
    // and combined with "Uncovered for you" it is the honest statement:
    // something implements this, and you cannot see it.
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("wi-secret");
    expect(text).not.toContain("password reset");
    expect(text).not.toContain("proj-1");
    expect(text).not.toContain("In Progress");
    // And no link out to it either, which would confirm it exists.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

// ===========================================================================
// 19. Keyboard and screen-reader behaviour
// ===========================================================================

describe("accessibility", () => {
  it("exposes requirements as a list", () => {
    setup({
      data: {
        items: [requirement(), requirement({ requirementId: "req-2", title: "Second" })],
        summary: summary({ total: 2, uncovered: 2 }),
      },
    });
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  });

  it("gives icon-only controls an accessible name", () => {
    setup({ data: { items: [requirement()], summary: summary() } });
    expect(
      screen.getByRole("button", { name: "Refresh delivery status" }),
    ).toBeInTheDocument();
  });

  it("reaches the create action by keyboard alone", async () => {
    setup({ data: { items: [requirement()], summary: summary() } });
    const button = screen.getByRole("button", { name: "Create linked work" });
    button.focus();
    expect(button).toHaveFocus();
  });

  it("does not offer creation when no project is mapped", () => {
    mockUsePageRequirements.mockReturnValue({
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
      data: { items: [requirement()], summary: summary() },
    });
    render(<RequirementDeliveryPanel pageId="page-1" />, { wrapper });

    // Nowhere to create the work: the action would only fail.
    expect(
      screen.queryByRole("button", { name: "Create linked work" }),
    ).not.toBeInTheDocument();
  });
});
