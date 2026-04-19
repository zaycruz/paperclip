import {
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { MarkdownBody } from "../components/MarkdownBody";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Activity, History, MessageSquarePlus, Send, X } from "lucide-react";
import { ActivityFeed } from "../components/ActivityFeed";
import { cn } from "../lib/utils";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

/**
 * Board Concierge Chat — a chat interface powered by the board-member skill.
 * Uses /board/chat/stream to invoke Claude with the board skill as system prompt.
 * The user manages their Paperclip company through natural conversation.
 */
/** Hit zone to the right of the 1px line (line sits on chat pane’s right edge). */
const SPLIT_DIVIDER_PX = 12;
const SPLIT_MIN_PANE_PX = 280;
/** Chat pane share of width below the divider (agent feed gets the rest). */
const DEFAULT_CHAT_FRACTION = 2 / 3;


/** Wrapped markdown in bubbles; pre/table scroll horizontally when needed. */
const BOARD_CHAT_MARKDOWN_CLASS =
  "max-w-full overflow-visible [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto";

const boardChatBubbleShell =
  "min-w-0 max-w-[85%] break-words px-3 py-2 text-sm overflow-x-auto overflow-y-visible";

export function BoardChat() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Conference Room" }]);
  }, [setBreadcrumbs]);

  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [chatPaneFraction, setChatPaneFraction] = useState(DEFAULT_CHAT_FRACTION);
  const splitDragging = useRef(false);


  useLayoutEffect(() => {
    const el = splitContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setContainerWidth(el.clientWidth);
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const innerWidth = Math.max(0, containerWidth - SPLIT_DIVIDER_PX);
  const splitLowerPx = SPLIT_MIN_PANE_PX;
  const splitUpperPx = innerWidth - SPLIT_MIN_PANE_PX;
  const minChatFraction =
    innerWidth > 0 ? Math.min(1, SPLIT_MIN_PANE_PX / innerWidth) : 0;
  const maxChatFraction =
    innerWidth > 0 ? Math.max(0, 1 - SPLIT_MIN_PANE_PX / innerWidth) : 1;
  const leftPaneWidth =
    innerWidth > 0
      ? splitUpperPx < splitLowerPx
        ? Math.max(0, Math.round(innerWidth / 2))
        : Math.round(
            innerWidth *
              Math.min(
                maxChatFraction,
                Math.max(minChatFraction, chatPaneFraction),
              ),
          )
      : 0;

  const handleSplitDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      splitDragging.current = true;
      const startX = e.clientX;
      const startWidth = leftPaneWidth;

      const onMouseMove = (ev: MouseEvent) => {
        if (!splitDragging.current) return;
        const containerW = splitContainerRef.current?.clientWidth ?? containerWidth;
        const inner = containerW - SPLIT_DIVIDER_PX;
        const lower = SPLIT_MIN_PANE_PX;
        const upper = inner - SPLIT_MIN_PANE_PX;
        const next = startWidth + ev.clientX - startX;
        if (inner <= 0) return;
        if (upper < lower) {
          setChatPaneFraction(0.5);
        } else {
          const clamped = Math.min(upper, Math.max(lower, next));
          setChatPaneFraction(clamped / inner);
        }
      };

      const onMouseUp = () => {
        splitDragging.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [containerWidth, leftPaneWidth],
  );

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [statusText, setStatusText] = useState("");
  const [boardIssueId, setBoardIssueId] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [optimisticMessage, setOptimisticMessage] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const hasRestoredScrollRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reset state and clear cached comments when company changes
  const prevCompanyRef = useRef(selectedCompanyId);
  useEffect(() => {
    if (prevCompanyRef.current !== selectedCompanyId) {
      if (boardIssueId) {
        queryClient.removeQueries({ queryKey: queryKeys.issues.comments(boardIssueId) });
      }
      setBoardIssueId(null);
      setStreamingText("");
      setStatusText("");
      setInput("");
      setSending(false);
      setOptimisticMessage(null);
      prevCompanyRef.current = selectedCompanyId;
    }
  }, [selectedCompanyId, boardIssueId, queryClient]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const ceoAgent = useMemo(
    () => agents?.find((a) => a.role === "ceo" && a.status !== "terminated"),
    [agents],
  );

  // Find or detect the board operations issue
  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    if (!issues) {
      setBoardIssueId(null);
      return;
    }
    const boardIssue = issues.find(
      (i) => i.title === "Board Operations" && i.status !== "done" && i.status !== "cancelled",
    );
    setBoardIssueId(boardIssue?.id ?? null);
  }, [issues]);

  // Fetch comments for the board issue
  const { data: comments } = useQuery({
    queryKey: queryKeys.issues.comments(boardIssueId ?? ""),
    queryFn: () => issuesApi.listComments(boardIssueId!),
    enabled: !!boardIssueId,
    refetchInterval: 3000,
  });

  const sortedComments = (comments ?? [])
    .slice()
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  // Clear optimistic message once server-persisted comments include it
  useEffect(() => {
    if (optimisticMessage && sortedComments.length > 0) {
      const lastUserComment = [...sortedComments]
        .reverse()
        .find((c) => !c.authorAgentId && c.authorUserId !== "board-concierge");
      if (lastUserComment?.body === optimisticMessage) {
        setOptimisticMessage(null);
      }
    }
  }, [sortedComments, optimisticMessage]);

  // Scroll behavior:
  //   - First mount in a session (no saved position): jump to bottom instantly.
  //   - Returning to the page within the same session: restore last scrollTop.
  //   - New content arriving: smooth-scroll to bottom only if user is already
  //     near the bottom, so we don't yank them away from reading history.
  //   - Scroll position is persisted to sessionStorage (cleared when tab closes).
  useEffect(() => {
    if (hasRestoredScrollRef.current) return;
    if (sortedComments.length === 0) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    try {
      const saved = sessionStorage.getItem("paperclip.boardChat.scrollTop");
      if (saved != null) {
        const parsed = Number(saved);
        if (Number.isFinite(parsed)) {
          container.scrollTop = parsed;
          hasRestoredScrollRef.current = true;
          return;
        }
      }
    } catch { /* sessionStorage unavailable */ }

    container.scrollTop = container.scrollHeight;
    hasRestoredScrollRef.current = true;
  }, [sortedComments.length]);

  useEffect(() => {
    if (!hasRestoredScrollRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom <= 80) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [sortedComments.length, streamingText, statusText, optimisticMessage]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    let rafId: number | null = null;
    const handleScroll = () => {
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        try {
          sessionStorage.setItem(
            "paperclip.boardChat.scrollTop",
            String(container.scrollTop),
          );
        } catch { /* sessionStorage unavailable */ }
      });
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScroll);
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, []);

  // Elapsed timer for thinking state
  useEffect(() => {
    if (sending) {
      setElapsedSec(0);
      elapsedTimerRef.current = setInterval(() => {
        setElapsedSec((prev) => prev + 1);
      }, 1000);
    } else {
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
    }
    return () => {
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    };
  }, [sending]);

  const sendMessage = useCallback(
    async (body: string) => {
      const trimmed = body.trim();
      if (!trimmed || sending || !selectedCompanyId) return;

      // Show user message immediately
      setOptimisticMessage(trimmed);
      setSending(true);
      setInput("");
      setStreamingText("");
      setStatusText("Connecting...");

      try {
        const controller = new AbortController();
        const fetchTimeout = setTimeout(() => controller.abort(), 130000);
        const res = await fetch("/api/board/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            companyId: selectedCompanyId,
            message: trimmed,
            taskId: boardIssueId ?? undefined,
          }),
          signal: controller.signal,
        });
        clearTimeout(fetchTimeout);

        if (!res.ok || !res.body) {
          throw new Error("Board chat stream not available");
        }

        setStatusText("Thinking...");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let accumulated = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "chunk" && event.text) {
                accumulated += event.text;
                setStreamingText(accumulated);
                setStatusText("");
              } else if (event.type === "status" && event.text) {
                setStatusText(event.text);
              } else if (event.type === "start" && event.issueId) {
                setBoardIssueId(event.issueId);
              } else if (event.type === "done") {
                if (event.issueId) {
                  queryClient.invalidateQueries({
                    queryKey: queryKeys.issues.comments(event.issueId),
                  });
                  queryClient.invalidateQueries({
                    queryKey: queryKeys.issues.list(selectedCompanyId),
                  });
                }
              }
            } catch {
              /* malformed SSE line */
            }
          }
        }

        setStreamingText("");
        setStatusText("");
        if (boardIssueId) {
          queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(boardIssueId) });
        }
      } catch (err) {
        console.error("Board chat error:", err);
        setStatusText("");
      } finally {
        setSending(false);
        inputRef.current?.focus();
      }
    },
    [sending, selectedCompanyId, boardIssueId, queryClient],
  );

  const handleSend = useCallback(() => {
    sendMessage(input);
  }, [input, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  if (!selectedCompanyId) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-sm">
          <h2 className="text-lg font-semibold">No company selected</h2>
          <p className="text-sm text-muted-foreground mt-2">
            Select a company to start chatting with your board concierge.
          </p>
        </div>
      </div>
    );
  }

  const [mobileFeedOpen, setMobileFeedOpen] = useState(false);

  return (
    <div className="flex h-[calc(100%+3rem)] flex-col -m-6">
      <div
        ref={splitContainerRef}
        className="flex min-h-0 min-w-0 flex-1 flex-row"
      >
        {/* Left: chat (self-contained pane) — full width on mobile, 2/3 default on desktop */}
        <div
          className={cn(
            "flex min-h-0 min-w-0 shrink-0 flex-col bg-background",
            "w-full md:w-auto",
            innerWidth <= 0 && "md:w-2/3",
          )}
          style={innerWidth > 0 && containerWidth >= 2 * SPLIT_MIN_PANE_PX + SPLIT_DIVIDER_PX ? { width: leftPaneWidth } : undefined}
        >
          <div className="relative flex shrink-0 items-center justify-between gap-2 px-4 py-3">
            <div
              className="pointer-events-none absolute bottom-0 left-0 right-0 h-px bg-border"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold">
                {ceoAgent?.name ?? "Conference Room"}
              </h3>
              <p className="text-xs text-muted-foreground">
                {selectedCompany?.name ?? "Your company"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground"
                    aria-label="chat history"
                  >
                    <History className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">chat history</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground"
                    aria-label="new chat"
                  >
                    <MessageSquarePlus className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">new chat</TooltipContent>
              </Tooltip>
            </div>
          </div>
          {/* Messages — scroll viewport flush right so the scrollbar sits on the pane/divider edge */}
          <div
            ref={scrollContainerRef}
            className="scrollbar-auto-hide min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
          >
            <div className="flex flex-col gap-4 px-4 py-3">
              {sortedComments.length === 0 && !streamingText && !sending && !optimisticMessage && (
                <div className="py-12 text-center">
                  <p className="mb-4 text-sm text-muted-foreground">
                    Ask me anything about your company — hiring, tasks, costs, approvals.
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {[
                      "What's happening today?",
                      "Help me build a hiring plan",
                      "Show me my costs",
                      "List pending approvals",
                    ].map((suggestion) => (
                      <button
                        key={suggestion}
                        onClick={() => sendMessage(suggestion)}
                        className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {sortedComments.map((comment) => {
                const isUser = !comment.authorAgentId && comment.authorUserId !== "board-concierge";
                return (
                  <div
                    key={comment.id}
                    className={cn("flex", isUser ? "justify-end" : "justify-start")}
                  >
                    <div
                      className={cn(
                        boardChatBubbleShell,
                        isUser
                          ? "bg-blue-600 text-white [border-radius:14px_14px_4px_14px]"
                          : "bg-card border border-border text-foreground [border-radius:14px_14px_14px_4px]",
                      )}
                    >
                      <MarkdownBody className={BOARD_CHAT_MARKDOWN_CLASS}>
                        {comment.body ?? ""}
                      </MarkdownBody>
                    </div>
                  </div>
                );
              })}

              {/* Optimistic user message — shows instantly before server persists */}
              {optimisticMessage && (
                <div className="flex justify-end">
                  <div
                    className={cn(
                      boardChatBubbleShell,
                      "bg-blue-600 text-white [border-radius:14px_14px_4px_14px]",
                    )}
                  >
                    {optimisticMessage}
                  </div>
                </div>
              )}

              {/* Streaming response */}
              {streamingText && (
                <div className="flex justify-start">
                  <div
                    className={cn(
                      boardChatBubbleShell,
                      "bg-card border border-border text-foreground [border-radius:14px_14px_14px_4px]",
                    )}
                  >
                    <MarkdownBody className={BOARD_CHAT_MARKDOWN_CLASS}>{streamingText}</MarkdownBody>
                  </div>
                </div>
              )}

              {/* Status bar — always visible while sending, independent from the chat bubble */}
              {sending && (
                <div className="flex items-center gap-2 pl-1 text-xs text-muted-foreground">
                  <img src="/paperclip-thinking.svg" alt="" className="inline-block shrink-0" style={{ width: 14, height: 14 }} />
                  <span>{statusText || "Thinking..."}</span>
                  {elapsedSec > 0 && (
                    <span className="opacity-50">{elapsedSec}s</span>
                  )}
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Input */}
          <div className="shrink-0 px-6 pt-3 pb-5">
            <div className="flex items-end gap-2 rounded-[10px] border border-border bg-card px-3 py-2 transition-colors duration-150 focus-within:border-muted-foreground/40">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value.replace(/\r?\n/g, " "))}
                onKeyDown={handleKeyDown}
                placeholder="Ask anything about your company..."
                rows={1}
                wrap="off"
                className="min-h-[22px] max-h-[140px] min-w-0 flex-1 resize-none overflow-x-auto whitespace-nowrap border-0 bg-transparent p-0 text-sm leading-6 outline-none placeholder:text-muted-foreground focus:outline-none focus:ring-0"
                disabled={sending}
              />
              <button
                type="button"
                onClick={handleSend}
                disabled={!input.trim() || sending}
                aria-label="Send message"
                className={cn(
                  "grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors duration-150 disabled:cursor-not-allowed",
                  input.trim() && !sending
                    ? "bg-foreground text-background hover:opacity-90"
                    : "bg-accent text-muted-foreground",
                )}
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Resize handle — hidden on mobile */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize board chat and agent feed"
          className="group relative hidden w-3 shrink-0 cursor-col-resize bg-background md:flex"
          onMouseDown={handleSplitDragStart}
        >
          <div
            className="pointer-events-none absolute top-0 bottom-0 left-0 w-px bg-border transition-colors group-hover:bg-foreground/20"
            aria-hidden
          />
        </div>

        {/* Right: Agent Feed — hidden on mobile */}
        <div className="hidden md:flex md:min-h-0 md:min-w-0 md:flex-1">
          <ActivityFeed />
        </div>
      </div>

      {/* Mobile: floating feed toggle + sheet drawer */}
      <div className="md:hidden">
        <Sheet open={mobileFeedOpen} onOpenChange={setMobileFeedOpen}>
          <SheetTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="secondary"
              className="fixed bottom-20 right-4 z-20 h-10 w-10 rounded-full shadow-lg"
              aria-label="Open agent feed"
            >
              <Activity className="h-4 w-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" className="h-[70vh] p-0 rounded-t-xl">
            <ActivityFeed />
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}
