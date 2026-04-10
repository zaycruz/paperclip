import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MailPlus } from "lucide-react";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";

export function CompanyInvites() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [humanRole, setHumanRole] = useState<"owner" | "admin" | "operator" | "viewer">("operator");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Invites" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const invitesQuery = useQuery({
    queryKey: queryKeys.access.invites(selectedCompanyId ?? "", "all"),
    queryFn: () => accessApi.listInvites(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const createInviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createCompanyInvite(selectedCompanyId!, {
        allowedJoinTypes: "human",
        humanRole,
        agentMessage: null,
      }),
    onSuccess: async (invite) => {
      let copied = false;

      try {
        if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(invite.inviteUrl);
          copied = true;
        }
      } catch {
        copied = false;
      }

      await queryClient.invalidateQueries({ queryKey: queryKeys.access.invites(selectedCompanyId!, "all") });
      pushToast({
        title: "Invite created",
        body: copied ? "Invite link copied to clipboard." : "Invite link created, but clipboard copy was unavailable.",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to create invite",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => accessApi.revokeInvite(inviteId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.invites(selectedCompanyId!, "all") });
      pushToast({ title: "Invite revoked", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to revoke invite",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">Select a company to manage invites.</div>;
  }

  if (invitesQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading invites…</div>;
  }

  if (invitesQuery.error) {
    const message =
      invitesQuery.error instanceof ApiError && invitesQuery.error.status === 403
        ? "You do not have permission to manage company invites."
        : invitesQuery.error instanceof Error
          ? invitesQuery.error.message
          : "Failed to load invites.";
    return <div className="text-sm text-destructive">{message}</div>;
  }

  return (
    <div className="max-w-5xl space-y-8">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <MailPlus className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Company Invites</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Create human invite links for company access. New invite links are copied to your clipboard when they are generated.
        </p>
      </div>

      <section className="space-y-4 rounded-xl border border-border p-5">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Create invite</h2>
          <p className="text-sm text-muted-foreground">
            Generate a human invite link and choose the default role it should request.
          </p>
        </div>

        <label className="block max-w-sm space-y-2 text-sm">
          <span className="font-medium">Default human role</span>
          <select
            className="w-full rounded-md border border-border bg-background px-3 py-2"
            value={humanRole}
            onChange={(event) =>
              setHumanRole(event.target.value as "owner" | "admin" | "operator" | "viewer")
            }
          >
            <option value="owner">Owner</option>
            <option value="admin">Admin</option>
            <option value="operator">Operator</option>
            <option value="viewer">Viewer</option>
          </select>
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => createInviteMutation.mutate()} disabled={createInviteMutation.isPending}>
            {createInviteMutation.isPending ? "Creating…" : "Create invite"}
          </Button>
          <span className="text-sm text-muted-foreground">Invite history below keeps the audit trail.</span>
        </div>
      </section>

      <section className="rounded-xl border border-border">
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">Invite history</h2>
            <p className="text-sm text-muted-foreground">
              Review invite status, role, inviter, and any linked join request.
            </p>
          </div>
          <Link to="/inbox/requests" className="text-sm underline underline-offset-4">
            Open join request queue
          </Link>
        </div>

        {(invitesQuery.data ?? []).length === 0 ? (
          <div className="border-t border-border px-5 py-8 text-sm text-muted-foreground">
            No invites have been created for this company yet.
          </div>
        ) : (
          <div className="overflow-x-auto border-t border-border">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-5 py-3 font-medium text-muted-foreground">State</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">Role</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">Invited by</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">Created</th>
                  <th className="px-5 py-3 font-medium text-muted-foreground">Join request</th>
                  <th className="px-5 py-3 text-right font-medium text-muted-foreground">Action</th>
                </tr>
              </thead>
              <tbody>
                {invitesQuery.data!.map((invite) => (
                  <tr key={invite.id} className="border-b border-border last:border-b-0">
                    <td className="px-5 py-3 align-top">
                      <span className="inline-flex rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                        {formatInviteState(invite.state)}
                      </span>
                    </td>
                    <td className="px-5 py-3 align-top">{invite.humanRole ?? "—"}</td>
                    <td className="px-5 py-3 align-top">
                      <div>{invite.invitedByUser?.name || invite.invitedByUser?.email || "Unknown inviter"}</div>
                      {invite.invitedByUser?.email && invite.invitedByUser.name ? (
                        <div className="text-xs text-muted-foreground">{invite.invitedByUser.email}</div>
                      ) : null}
                    </td>
                    <td className="px-5 py-3 align-top text-muted-foreground">
                      {new Date(invite.createdAt).toLocaleString()}
                    </td>
                    <td className="px-5 py-3 align-top">
                      {invite.relatedJoinRequestId ? (
                        <Link to="/inbox/requests" className="underline underline-offset-4">
                          Review request
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right align-top">
                      {invite.state === "active" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => revokeMutation.mutate(invite.id)}
                          disabled={revokeMutation.isPending}
                        >
                          Revoke
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">Inactive</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function formatInviteState(state: "active" | "accepted" | "expired" | "revoked") {
  return state.charAt(0).toUpperCase() + state.slice(1);
}
