// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyInvites } from "./CompanyInvites";

const listInvitesMock = vi.hoisted(() => vi.fn());
const createCompanyInviteMock = vi.hoisted(() => vi.fn());
const revokeInviteMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const clipboardWriteTextMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/access", () => ({
  accessApi: {
    listInvites: (companyId: string) => listInvitesMock(companyId),
    createCompanyInvite: (companyId: string, input: unknown) =>
      createCompanyInviteMock(companyId, input),
    revokeInvite: (inviteId: string) => revokeInviteMock(inviteId),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("CompanyInvites", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    listInvitesMock.mockResolvedValue([
      {
        id: "invite-1",
        companyId: "company-1",
        inviteType: "company_join",
        tokenHash: "hash-1",
        allowedJoinTypes: "human",
        defaultsPayload: null,
        expiresAt: "2026-04-20T00:00:00.000Z",
        invitedByUserId: "user-1",
        revokedAt: null,
        acceptedAt: null,
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:00:00.000Z",
        companyName: "Paperclip",
        humanRole: "operator",
        inviteMessage: null,
        state: "active",
        invitedByUser: {
          id: "user-1",
          name: "Board User",
          email: "board@paperclip.local",
          image: null,
        },
        relatedJoinRequestId: "join-1",
      },
      {
        id: "invite-2",
        companyId: "company-1",
        inviteType: "company_join",
        tokenHash: "hash-2",
        allowedJoinTypes: "human",
        defaultsPayload: null,
        expiresAt: "2026-04-20T00:00:00.000Z",
        invitedByUserId: "user-1",
        revokedAt: null,
        acceptedAt: "2026-04-11T00:00:00.000Z",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
        companyName: "Paperclip",
        humanRole: "viewer",
        inviteMessage: null,
        state: "accepted",
        invitedByUser: {
          id: "user-1",
          name: "Board User",
          email: "board@paperclip.local",
          image: null,
        },
        relatedJoinRequestId: null,
      },
    ]);

    createCompanyInviteMock.mockResolvedValue({
      inviteUrl: "https://paperclip.local/invite/new-token",
      onboardingTextUrl: null,
      onboardingTextPath: null,
      humanRole: "viewer",
      allowedJoinTypes: "human",
    });

    revokeInviteMock.mockResolvedValue(undefined);

    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteTextMock },
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders a human-only invite flow and keeps invite history in a table", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <CompanyInvites />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Company Invites");
    expect(container.textContent).toContain("Create invite");
    expect(container.textContent).toContain("Invite history");
    expect(container.textContent).toContain("Board User");
    expect(container.textContent).toContain("Review request");
    expect(container.textContent).not.toContain("Human or agent");
    expect(container.textContent).not.toContain("Invite message");
    expect(container.textContent).not.toContain("Latest generated invite");
    expect(container.textContent).not.toContain("Active invites");
    expect(container.textContent).not.toContain("Consumed invites");
    expect(container.textContent).not.toContain("Expired invites");
    expect(container.textContent).not.toContain("OpenClaw shortcut");

    const roleSelect = container.querySelector("select") as HTMLSelectElement | null;
    expect(roleSelect).not.toBeNull();

    await act(async () => {
      if (roleSelect) {
        roleSelect.value = "viewer";
        roleSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    const createButton = buttons.find((button) => button.textContent === "Create invite");
    const revokeButton = buttons.find((button) => button.textContent === "Revoke");

    expect(createButton).toBeTruthy();
    expect(revokeButton).toBeTruthy();

    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(createCompanyInviteMock).toHaveBeenCalledWith("company-1", {
      allowedJoinTypes: "human",
      humanRole: "viewer",
      agentMessage: null,
    });
    expect(clipboardWriteTextMock).toHaveBeenCalledWith("https://paperclip.local/invite/new-token");
    expect(pushToastMock).toHaveBeenCalledWith({
      title: "Invite created",
      body: "Invite link copied to clipboard.",
      tone: "success",
    });

    await act(async () => {
      revokeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(revokeInviteMock).toHaveBeenCalledWith("invite-1");

    await act(async () => {
      root.unmount();
    });
  });
});
