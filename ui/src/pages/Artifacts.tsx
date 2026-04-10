import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import type { CompanyDeliverableItem } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { projectUrl, relativeTime } from "../lib/utils";
import {
  ArrowUpRight,
  ExternalLink,
  FileImage,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequestArrow,
  Hexagon,
  MonitorUp,
  Package,
  Search,
} from "lucide-react";

type DeliverableFilter = "all" | "documents" | "files" | "previews" | "pullRequests" | "code";

function labelize(value: string | null | undefined) {
  if (!value) return null;
  return value.replace(/_/g, " ");
}

function readMetadataString(item: CompanyDeliverableItem, key: string) {
  const value = item.metadata?.[key];
  return typeof value === "string" ? value : null;
}

function formatByteSize(byteSize: number | null) {
  if (!byteSize || byteSize <= 0) return null;
  if (byteSize < 1024 * 1024) return `${(byteSize / 1024).toFixed(1)} KB`;
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}

function isImageItem(item: CompanyDeliverableItem) {
  const contentType = item.contentType ?? readMetadataString(item, "contentType");
  return Boolean(contentType?.startsWith("image/"));
}

function itemHref(item: CompanyDeliverableItem) {
  if (item.kind === "document" && item.documentKey) {
    return `${createIssueDetailPath(item.issueIdentifier ?? item.issueId)}#document-${encodeURIComponent(item.documentKey)}`;
  }
  return item.url;
}

function actionLabel(item: CompanyDeliverableItem) {
  if (item.kind === "document") return "Open doc";
  if (item.kind === "preview_url" || item.kind === "runtime_service") return "Open preview";
  if (item.kind === "pull_request") return "Open PR";
  if (item.kind === "branch" || item.kind === "commit") return "Open reference";
  return isImageItem(item) ? "Open file" : "Download";
}

function filterMatches(item: CompanyDeliverableItem, filter: DeliverableFilter) {
  if (filter === "all") return true;
  if (filter === "documents") return item.kind === "document";
  if (filter === "files") return item.kind === "artifact" || item.kind === "attachment";
  if (filter === "previews") return item.kind === "preview_url" || item.kind === "runtime_service";
  if (filter === "pullRequests") return item.kind === "pull_request";
  return item.kind === "branch" || item.kind === "commit";
}

function deliverableMeta(item: CompanyDeliverableItem) {
  switch (item.kind) {
    case "document":
      return {
        label: "Document",
        icon: FileText,
        accentClass: "from-amber-200/80 via-amber-50 to-background",
        badgeClass: "bg-amber-500/10 text-amber-700 border-amber-500/20",
      };
    case "preview_url":
    case "runtime_service":
      return {
        label: "Preview",
        icon: MonitorUp,
        accentClass: "from-emerald-200/70 via-emerald-50/60 to-background",
        badgeClass: "bg-emerald-500/10 text-emerald-700 border-emerald-500/20",
      };
    case "pull_request":
      return {
        label: "Pull request",
        icon: GitPullRequestArrow,
        accentClass: "from-sky-200/70 via-sky-50/60 to-background",
        badgeClass: "bg-sky-500/10 text-sky-700 border-sky-500/20",
      };
    case "branch":
      return {
        label: "Branch",
        icon: GitBranch,
        accentClass: "from-violet-200/70 via-violet-50/60 to-background",
        badgeClass: "bg-violet-500/10 text-violet-700 border-violet-500/20",
      };
    case "commit":
      return {
        label: "Commit",
        icon: GitCommitHorizontal,
        accentClass: "from-fuchsia-200/70 via-fuchsia-50/60 to-background",
        badgeClass: "bg-fuchsia-500/10 text-fuchsia-700 border-fuchsia-500/20",
      };
    default:
      return {
        label: "File",
        icon: isImageItem(item) ? FileImage : Package,
        accentClass: "from-zinc-200/70 via-zinc-50/60 to-background",
        badgeClass: "bg-zinc-500/10 text-zinc-700 border-zinc-500/20",
      };
  }
}

function ArtifactCard({
  item,
  projectName,
  projectHref,
}: {
  item: CompanyDeliverableItem;
  projectName: string | null;
  projectHref: string | null;
}) {
  const meta = deliverableMeta(item);
  const href = itemHref(item);
  const sizeLabel = formatByteSize(item.byteSize);
  const imagePreview = isImageItem(item) && item.url ? item.url : null;
  const MetaIcon = meta.icon;
  const isInternalDocLink = Boolean(href?.startsWith("/issues/"));

  return (
    <article className="group overflow-hidden rounded-[1.4rem] border border-border/80 bg-card shadow-[0_20px_60px_-40px_rgba(15,23,42,0.35)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_28px_70px_-38px_rgba(15,23,42,0.45)]">
      {imagePreview ? (
        <div className="aspect-[16/10] overflow-hidden border-b border-border/80 bg-muted/40">
          <img
            src={imagePreview}
            alt={item.title}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        </div>
      ) : (
        <div className={`border-b border-border/80 bg-gradient-to-br ${meta.accentClass}`}>
          <div className="flex aspect-[16/10] flex-col justify-between p-5">
            <div className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${meta.badgeClass}`}>
              <MetaIcon className="h-3.5 w-3.5" />
              {meta.label}
            </div>
            {item.kind === "document" ? (
              <div className="rounded-2xl border border-black/5 bg-white/80 p-4 shadow-sm">
                <p className="line-clamp-4 text-sm leading-6 text-slate-700">
                  {item.summary ?? "This document does not have a preview snippet yet."}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <MetaIcon className="h-10 w-10 text-foreground/70" />
                <p className="max-w-[14rem] text-sm text-muted-foreground">
                  {item.summary ?? item.contentType ?? labelize(item.kind) ?? "Deliverable"}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="space-y-4 p-5">
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{meta.label}</Badge>
            {item.provider ? <Badge variant="secondary">{item.provider}</Badge> : null}
            {item.status ? <Badge variant="secondary">{labelize(item.status)}</Badge> : null}
            {item.reviewState && item.reviewState !== "none" ? (
              <Badge variant="secondary">{labelize(item.reviewState)}</Badge>
            ) : null}
            {item.isPrimary ? <Badge variant="secondary">Primary</Badge> : null}
            {item.documentKey ? <Badge variant="secondary">{item.documentKey}</Badge> : null}
            {item.revisionNumber ? <Badge variant="secondary">v{item.revisionNumber}</Badge> : null}
            {sizeLabel ? <Badge variant="secondary">{sizeLabel}</Badge> : null}
          </div>

          <div>
            <h3 className="line-clamp-2 text-lg font-semibold leading-tight">{item.title}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Updated {relativeTime(item.updatedAt)}
            </p>
          </div>

          {item.summary && item.kind !== "document" ? (
            <p className="line-clamp-3 text-sm text-muted-foreground">{item.summary}</p>
          ) : null}
        </div>

        <div className="space-y-3 rounded-2xl border border-border/70 bg-muted/20 p-3.5">
          <div className="flex items-start gap-2">
            <Package className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Issue</p>
              <Link
                to={createIssueDetailPath(item.issueIdentifier ?? item.issueId)}
                className="line-clamp-2 text-sm font-medium hover:underline"
              >
                {item.issueTitle}
              </Link>
              {item.issueIdentifier ? (
                <p className="text-xs text-muted-foreground">{item.issueIdentifier}</p>
              ) : null}
            </div>
          </div>

          {projectHref && projectName ? (
            <div className="flex items-start gap-2">
              <Hexagon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Project</p>
                <Link to={projectHref} className="line-clamp-1 text-sm font-medium hover:underline">
                  {projectName}
                </Link>
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          {href ? (
            isInternalDocLink ? (
              <Button asChild size="sm" variant="outline">
                <Link to={href}>
                  <ArrowUpRight className="mr-1.5 h-4 w-4" />
                  {actionLabel(item)}
                </Link>
              </Button>
            ) : href.startsWith("/") ? (
              <Button asChild size="sm" variant="outline">
                <a href={href}>
                  <ArrowUpRight className="mr-1.5 h-4 w-4" />
                  {actionLabel(item)}
                </a>
              </Button>
            ) : (
              <Button asChild size="sm" variant="outline">
                <a href={href} target="_blank" rel="noreferrer">
                  <ArrowUpRight className="mr-1.5 h-4 w-4" />
                  {actionLabel(item)}
                </a>
              </Button>
            )
          ) : null}
          <Button asChild size="sm" variant="ghost">
            <Link to={createIssueDetailPath(item.issueIdentifier ?? item.issueId)}>
              <ExternalLink className="mr-1.5 h-4 w-4" />
              Open issue
            </Link>
          </Button>
        </div>
      </div>
    </article>
  );
}

export function Artifacts() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<DeliverableFilter>("all");
  const deferredSearch = useDeferredValue(search);

  useEffect(() => {
    setBreadcrumbs([{ label: "Artifacts" }]);
  }, [setBreadcrumbs]);

  const { data: deliverables, isLoading, error } = useQuery({
    queryKey: queryKeys.artifacts.list(selectedCompanyId!),
    queryFn: () => issuesApi.listCompanyDeliverables(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const projectMap = useMemo(() => {
    const map = new Map<string, { title: string; href: string }>();
    for (const project of projects ?? []) {
      map.set(project.id, { title: project.name, href: projectUrl(project) });
    }
    return map;
  }, [projects]);

  const filteredItems = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    return (deliverables?.items ?? []).filter((item) => {
      if (!filterMatches(item, filter)) return false;
      if (!query) return true;
      const haystack = [
        item.title,
        item.summary ?? "",
        item.issueTitle,
        item.issueIdentifier ?? "",
        item.documentKey ?? "",
        item.provider ?? "",
      ]
        .join("\n")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [deferredSearch, deliverables?.items, filter]);

  const featuredItems = useMemo(() => {
    const candidates = filteredItems.filter((item) => item.isPrimary);
    return (candidates.length > 0 ? candidates : filteredItems).slice(0, 3);
  }, [filteredItems]);

  const featuredIds = useMemo(() => new Set(featuredItems.map((item) => item.id)), [featuredItems]);
  const remainingItems = useMemo(
    () => filteredItems.filter((item) => !featuredIds.has(item.id)),
    [featuredIds, filteredItems],
  );
  const showSpotlight = filter === "all" && !deferredSearch.trim() && featuredItems.length > 0;
  const feedItems = showSpotlight && remainingItems.length > 0 ? remainingItems : filteredItems;

  const filterOptions = [
    { id: "all" as const, label: "All", count: deliverables?.summary.totalCount ?? 0 },
    { id: "documents" as const, label: "Docs", count: deliverables?.summary.documentCount ?? 0 },
    { id: "files" as const, label: "Files", count: deliverables?.summary.fileCount ?? 0 },
    { id: "previews" as const, label: "Previews", count: deliverables?.summary.previewCount ?? 0 },
    { id: "pullRequests" as const, label: "PRs", count: deliverables?.summary.pullRequestCount ?? 0 },
    {
      id: "code" as const,
      label: "Branches + commits",
      count: (deliverables?.summary.branchCount ?? 0) + (deliverables?.summary.commitCount ?? 0),
    },
  ];

  if (!selectedCompanyId) {
    return <EmptyState icon={Package} message="Select a company to view artifacts." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="grid" />;
  }

  return (
    <div className="space-y-8">
      <section className="overflow-hidden rounded-[1.75rem] border border-border/80 bg-gradient-to-br from-amber-50 via-background to-sky-50 shadow-[0_30px_80px_-50px_rgba(15,23,42,0.35)]">
        <div className="grid gap-6 px-6 py-7 lg:grid-cols-[1.35fr_0.65fr] lg:px-8">
          <div className="space-y-4">
            <Badge variant="outline" className="bg-background/70">Company deliverables</Badge>
            <div className="space-y-2">
              <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-balance">
                Documents, files, previews, and other work product in one place.
              </h2>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                Browse what agents have actually produced across the company. This view mixes issue documents,
                uploaded files, previews, pull requests, branches, commits, and artifact records into one operator-facing gallery.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Items</p>
              <p className="mt-2 text-3xl font-semibold">{deliverables?.summary.totalCount ?? 0}</p>
              <p className="mt-1 text-xs text-muted-foreground">Mixed deliverables in the feed</p>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Issues</p>
              <p className="mt-2 text-3xl font-semibold">{deliverables?.summary.issueCount ?? 0}</p>
              <p className="mt-1 text-xs text-muted-foreground">Tasks with visible output</p>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Docs</p>
              <p className="mt-2 text-3xl font-semibold">{deliverables?.summary.documentCount ?? 0}</p>
              <p className="mt-1 text-xs text-muted-foreground">Plans, briefs, reports, notes</p>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Primary</p>
              <p className="mt-2 text-3xl font-semibold">{deliverables?.summary.primaryCount ?? 0}</p>
              <p className="mt-1 text-xs text-muted-foreground">Explicitly promoted outputs</p>
            </div>
          </div>
        </div>
      </section>

      {error ? <p className="text-sm text-destructive">{error.message}</p> : null}

      {!isLoading && (deliverables?.summary.totalCount ?? 0) === 0 ? (
        <EmptyState
          icon={Package}
          message="No deliverables yet. Issue documents, uploaded files, previews, and other work product will appear here."
        />
      ) : null}

      {deliverables && deliverables.summary.totalCount > 0 ? (
        <>
          <section className="space-y-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap gap-2">
                {filterOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setFilter(option.id)}
                    className={
                      option.id === filter
                        ? "inline-flex items-center gap-2 rounded-full border border-foreground/20 bg-foreground px-3.5 py-2 text-sm font-medium text-background"
                        : "inline-flex items-center gap-2 rounded-full border border-border bg-background px-3.5 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
                    }
                  >
                    <span>{option.label}</span>
                    <span className={option.id === filter ? "text-background/75" : "text-muted-foreground"}>
                      {option.count}
                    </span>
                  </button>
                ))}
              </div>

              <div className="relative w-full lg:w-[22rem]">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search titles, issues, providers..."
                  className="pl-9"
                />
              </div>
            </div>
          </section>

          {showSpotlight ? (
            <section className="space-y-4">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Spotlight</p>
                  <h3 className="text-xl font-semibold">Recent output worth opening first</h3>
                </div>
                <p className="text-sm text-muted-foreground">
                  Primary items and the freshest deliverables float to the top.
                </p>
              </div>
              <div className="grid gap-4 xl:grid-cols-3">
                {featuredItems.map((item) => {
                  const project = item.projectId ? projectMap.get(item.projectId) ?? null : null;
                  return (
                    <ArtifactCard
                      key={item.id}
                      item={item}
                      projectName={project?.title ?? null}
                      projectHref={project?.href ?? null}
                    />
                  );
                })}
              </div>
            </section>
          ) : null}

          <section className="space-y-4">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Feed</p>
                <h3 className="text-xl font-semibold">
                  {deferredSearch.trim() || filter !== "all" ? "Filtered deliverables" : "Latest deliverables"}
                </h3>
              </div>
              <p className="text-sm text-muted-foreground">{filteredItems.length} visible item{filteredItems.length === 1 ? "" : "s"}</p>
            </div>

            {filteredItems.length === 0 ? (
              <div className="rounded-[1.5rem] border border-dashed border-border px-6 py-12 text-center">
                <p className="text-base font-medium">No deliverables match the current filter.</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Try another filter or clear the search to see more issue output.
                </p>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {feedItems.map((item) => {
                  const project = item.projectId ? projectMap.get(item.projectId) ?? null : null;
                  return (
                    <ArtifactCard
                      key={item.id}
                      item={item}
                      projectName={project?.title ?? null}
                      projectHref={project?.href ?? null}
                    />
                  );
                })}
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
