import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Sparkles,
  Send,
  X,
  User as UserIcon,
  Bot,
  AlertCircle,
  AlertTriangle,
  Info,
  Copy,
  Check,
} from 'lucide-react';
import clsx from 'clsx';
import { ai as aiApi } from '@/api/client';
import type {
  ChatToolStartEvent,
  ChatToolResultEvent,
} from '@/api/client';
import { useFilterStore } from '@/store/filterStore';
import { useUIStore } from '@/store';
import { Markdown } from '@/components/common/Markdown';
import {
  ToolResultRender,
  type ToolCallState,
} from './ChatCharts';

// Global Ask-AI chat panel — slides in from the right on top of any
// authenticated page. The trigger button lives in Header.tsx (always
// visible top-right, not buried under any tab). This component owns
// only the slide-in panel body; open/close state is shared via
// useUIStore.aiChatOpen so Header can toggle it.
//
// Key behaviours:
//   - Detects the current event-log id from the URL (`/process/:id`,
//     `/variants/:id`, `/bottlenecks/:id`, `/conformance/:id`,
//     `/root-cause/:id`, `/dotted-chart/:id`, `/social-network/:id`,
//     `/rework/:id`, `/comparison/:id`, `/simulate/:id`, `/animation/:id`,
//     `/sustainability/:id`, `/mission-control/:id`, `/ocpm/:id`).
//     When the route has no eventLogId, opening the panel shows a
//     short "navigate to a log first" hint instead of failing.
//   - Auto-injects the active filter chip set into every prompt.
//   - Streaming responses via the existing `/ai/chat` SSE endpoint.

interface Message {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
  toolCalls?: ToolCallState[];
}

interface TopFinding {
  severity: string;
  title: string;
  description: string;
}

// Fallback suggestions used when the data-anchored endpoint hasn't
// returned yet, or when the log has no findings worth highlighting.
const DEFAULT_SUGGESTIONS = [
  'Summarise the health of this process in three bullets.',
  'What are the top bottlenecks and why?',
  'Where should we focus automation first?',
];

// Routes whose first param is an event-log UUID. ``task-mining`` is
// intentionally excluded — its first param is a project id, not an
// event log, and the chat backend would 422 on that.
const ROUTE_PATTERN = new RegExp(
  '^/(?:process|variants|bottlenecks|conformance|root-cause|dotted-chart|' +
    'social-network|rework|comparison|simulate|animation|sustainability|' +
    'mission-control|ocpm)/' +
    '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})',
);

function eventLogIdFromPath(pathname: string): string | null {
  const m = pathname.match(ROUTE_PATTERN);
  return m ? m[1] : null;
}

let _msgCounter = 0;

export default function FloatingAIChat() {
  const location = useLocation();
  const eventLogId = useMemo(() => eventLogIdFromPath(location.pathname), [location.pathname]);
  const open = useUIStore((s) => s.aiChatOpen);
  const setOpen = useUIStore((s) => s.setAiChatOpen);
  const prefill = useUIStore((s) => s.aiChatPrefill);
  const clearPrefill = useUIStore((s) => s.setAiChatPrefill);
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>(DEFAULT_SUGGESTIONS);
  const [topFindings, setTopFindings] = useState<TopFinding[]>([]);
  const [copiedMsgId, setCopiedMsgId] = useState<number | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Focus the input whenever the panel becomes visible so the user can
  // start typing immediately without having to click into the field.
  useEffect(() => {
    if (open) {
      // Defer one tick so the element is mounted and focusable.
      const id = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
  }, [open]);

  // Consume any pending prefill from the store — this is how
  // external components (InsightsPanel, OCPM cards, finding tables)
  // open the chat with a question already filled in.
  useEffect(() => {
    if (open && prefill) {
      setQuestion(prefill);
      clearPrefill(null);
      // Focus after state settles so the caret lands at the end.
      setTimeout(() => {
        inputRef.current?.focus();
        const el = inputRef.current;
        if (el) el.setSelectionRange(el.value.length, el.value.length);
      }, 60);
    }
  }, [open, prefill, clearPrefill]);

  // Fetch data-anchored suggestions and top-findings whenever a new
  // event log comes into scope. Cached server-side so this is a cheap
  // Redis hit after the first call per log.
  useEffect(() => {
    if (!open || !eventLogId) return;
    let cancelled = false;
    aiApi
      .chatSuggestions(eventLogId)
      .then((r) => {
        if (cancelled) return;
        if (Array.isArray(r.suggestions) && r.suggestions.length) {
          setSuggestions(r.suggestions);
        }
        setTopFindings(r.top_findings ?? []);
      })
      .catch(() => {
        // Fall back to defaults — this is a progressive-enhancement
        // path, not a blocker for using the chat.
        if (!cancelled) {
          setSuggestions(DEFAULT_SUGGESTIONS);
          setTopFindings([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, eventLogId]);

  // Don't render the panel on non-log routes, but we still need the
  // component mounted so Header's trigger has a target. When eventLogId
  // is null and the user opens the chat, we show a short hint panel
  // telling them to navigate to a log first.
  if (!open) return null;

  if (!eventLogId) {
    return (
      <div className="fixed inset-0 z-[60] flex items-stretch justify-end bg-black/40">
        <div
          className="absolute inset-0"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
        <div className="relative flex h-full w-full max-w-md flex-col border-l border-line bg-surface-0 shadow-2xl">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div className="flex items-center gap-2">
              <Sparkles size={14} className="text-accent" />
              <span className="text-[12px] font-semibold text-fg">Ask AI</span>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded p-1 text-fg-muted hover:bg-tint hover:text-fg"
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-4">
            <p className="text-[12px] text-fg-muted">
              Open a specific event log first (via the Projects page or
              Overview) and I'll be able to answer questions about it —
              bottlenecks, variants, conformance, and any active filter
              chips.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const ask = async (q: string) => {
    const text = q.trim();
    if (!text || loading) return;
    setQuestion('');

    const userMsg: Message = { id: ++_msgCounter, role: 'user', text };
    const assistantMsg: Message = {
      id: ++_msgCounter,
      role: 'assistant',
      text: '',
      streaming: true,
      toolCalls: [],
    };
    setMessages((m) => [...m, userMsg, assistantMsg]);
    setLoading(true);

    // Inject current filter chip context (Apromore + KYP.ai parity).
    const chips = useFilterStore.getState().chips;
    const disabled = useFilterStore.getState().disabled;
    const active = chips.filter((c) => !disabled[c.id]);
    // Derive the current page from the URL so the LLM knows what the
    // user is looking at.
    const pageSegment = location.pathname.split('/')[1] ?? '';
    const PAGE_LABELS: Record<string, string> = {
      process: 'Process Map / Overview',
      variants: 'Variant Analysis',
      bottlenecks: 'Bottleneck Analysis',
      conformance: 'Conformance Checking',
      'root-cause': 'Root Cause Analysis',
      'dotted-chart': 'Dotted Chart',
      'social-network': 'Social Network Analysis',
      rework: 'Rework Analysis',
      comparison: 'Comparison View',
      simulate: 'What-If Simulation',
      animation: 'Process Animation',
      sustainability: 'Sustainability / CO₂',
      'mission-control': 'Mission Control',
      ocpm: 'Object-Centric Process Mining',
    };
    const pageLabel = PAGE_LABELS[pageSegment];
    const pagePreamble = pageLabel
      ? `The user is currently viewing the **${pageLabel}** page. Tailor your answer to what they see on screen.\n\n`
      : '';

    const filterPreamble =
      active.length > 0
        ? `Current analysis filters: ${active.map((c) => c.label).join(' · ')}. Take these into account.\n\n`
        : '';

    const enriched = pagePreamble + filterPreamble + text;

    try {
      await aiApi.chatStream(eventLogId, enriched, {
        onChunk: (chunk) => {
          setMessages((m) =>
            m.map((msg) =>
              msg.id === assistantMsg.id ? { ...msg, text: msg.text + chunk } : msg,
            ),
          );
        },
        onToolStart: (event: ChatToolStartEvent) => {
          setMessages((m) =>
            m.map((msg) => {
              if (msg.id !== assistantMsg.id) return msg;
              const existing = msg.toolCalls ?? [];
              // Skip duplicates — the stream sometimes replays an id
              // across turns; we append only new ids.
              if (existing.some((t) => t.id === event.id)) return msg;
              return {
                ...msg,
                toolCalls: [
                  ...existing,
                  {
                    id: event.id,
                    name: event.name,
                    args: event.args,
                    result: null,
                  },
                ],
              };
            }),
          );
        },
        onToolResult: (event: ChatToolResultEvent) => {
          setMessages((m) =>
            m.map((msg) => {
              if (msg.id !== assistantMsg.id) return msg;
              const existing = msg.toolCalls ?? [];
              return {
                ...msg,
                toolCalls: existing.map((t) =>
                  t.id === event.id ? { ...t, result: event.result } : t,
                ),
              };
            }),
          );
        },
        onWarning: (message) => {
          // Warnings are non-fatal — log to console for the dev to
          // inspect but don't clutter the chat UI.
          console.warn('[Ask AI]', message);
        },
      });
      setMessages((m) =>
        m.map((msg) =>
          msg.id === assistantMsg.id ? { ...msg, streaming: false } : msg,
        ),
      );
    } catch (err) {
      setMessages((m) =>
        m.map((msg) =>
          msg.id === assistantMsg.id
            ? {
                ...msg,
                text: `Request failed: ${err instanceof Error ? err.message : 'unknown error'}`,
                streaming: false,
              }
            : msg,
        ),
      );
    } finally {
      setLoading(false);
    }
  };

  const severityIcon = (sev: string) => {
    if (sev === 'critical') return <AlertCircle size={12} className="shrink-0 text-danger" />;
    if (sev === 'warning') return <AlertTriangle size={12} className="shrink-0 text-warning" />;
    return <Info size={12} className="shrink-0 text-accent" />;
  };

  const copyMessage = (msg: Message) => {
    navigator.clipboard.writeText(msg.text).then(
      () => {
        setCopiedMsgId(msg.id);
        setTimeout(() => setCopiedMsgId(null), 1500);
      },
      () => {},
    );
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-stretch justify-end bg-black/40">
      <div
        className="absolute inset-0"
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />
      <div className="relative flex h-full w-full max-w-md flex-col border-l border-line bg-surface-0 shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div className="flex items-center gap-2">
                <Sparkles size={14} className="text-accent" />
                <span className="text-[12px] font-semibold text-fg">Ask AI</span>
                <span className="rounded-full bg-tint px-2 py-0.5 text-[10px] text-fg-faint">
                  {eventLogId.slice(0, 8)}…
                </span>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded p-1 text-fg-muted hover:bg-tint hover:text-fg"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>

            {/* Thread */}
            <div ref={threadRef} className="flex-1 overflow-y-auto px-4 py-4">
              {messages.length === 0 ? (
                <div className="space-y-4">
                  <p className="text-[11px] text-fg-muted">
                    Ask anything about this event log. The model already
                    knows about your bottlenecks, variants, conformance,
                    and any active filter chips. Type below, or tap a
                    suggestion to prefill the input and edit it first.
                  </p>

                  {/* Top findings from THIS log — click to explain. */}
                  {topFindings.length > 0 && (
                    <div>
                      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
                        Top findings in this log
                      </p>
                      <div className="space-y-1.5">
                        {topFindings.map((f, i) => (
                          <button
                            key={`${f.title}-${i}`}
                            type="button"
                            onClick={() => {
                              setQuestion(`Explain this finding: ${f.title}`);
                              inputRef.current?.focus();
                            }}
                            className="flex w-full items-start gap-2 rounded-md border border-line bg-surface-1 px-3 py-2 text-left transition-colors hover:border-accent/60 hover:bg-accent/5"
                            title="Click to prefill — then hit Enter to explain"
                          >
                            <div className="mt-0.5">{severityIcon(f.severity)}</div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[11px] font-semibold text-fg">
                                {f.title}
                              </p>
                              <p className="mt-0.5 line-clamp-2 text-[10px] text-fg-muted">
                                {f.description}
                              </p>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Data-anchored question suggestions. */}
                  <div>
                    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
                      {topFindings.length > 0 ? 'Or ask about' : 'Suggestions'}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {suggestions.map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => {
                            setQuestion(s);
                            inputRef.current?.focus();
                          }}
                          className="rounded-full border border-line bg-surface-1 px-3 py-1 text-[11px] text-fg-secondary transition-colors hover:border-accent/60 hover:bg-accent/5 hover:text-accent"
                          title="Click to prefill, then edit before sending"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {messages.map((m) => (
                    <div key={m.id} className="group flex items-start gap-2">
                      <div
                        className={clsx(
                          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
                          m.role === 'user'
                            ? 'bg-tint text-fg-muted'
                            : 'bg-accent/10 text-accent',
                        )}
                      >
                        {m.role === 'user' ? <UserIcon size={11} /> : <Bot size={11} />}
                      </div>
                      <div className="min-w-0 flex-1">
                        {/* Tool calls render above the prose so the
                            chart lands next to the paragraph that
                            references it. */}
                        {m.toolCalls && m.toolCalls.length > 0 && (
                          <div className="mb-1 space-y-1">
                            {m.toolCalls.map((tc) => (
                              <ToolResultRender key={tc.id} tc={tc} eventLogId={eventLogId ?? undefined} />
                            ))}
                          </div>
                        )}
                        {m.text && (
                          <div className="relative text-[12px] leading-relaxed text-fg-secondary">
                            {m.role === 'assistant' ? (
                              // Assistant output is markdown (the system
                              // prompt tells the model to emit **bold**,
                              // ## headings, - bullets, etc.). Render it
                              // through the shared streaming renderer.
                              <Markdown text={m.text} variant="compact" />
                            ) : (
                              // User input is plain text — preserve
                              // newlines but don't parse markdown.
                              <p className="whitespace-pre-wrap">{m.text}</p>
                            )}
                            {m.streaming && (
                              <span className="ml-1 inline-block h-2 w-1.5 animate-pulse bg-accent" />
                            )}
                          </div>
                        )}
                        {m.streaming && !m.text && (!m.toolCalls || m.toolCalls.length === 0) && (
                          <p className="text-[11px] text-fg-faint">
                            <span className="inline-block h-2 w-1.5 animate-pulse bg-accent" />{' '}
                            Thinking…
                          </p>
                        )}
                        {m.role === 'assistant' && !m.streaming && m.text && (
                          <button
                            type="button"
                            onClick={() => copyMessage(m)}
                            className="mt-1 flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-fg-faint opacity-0 transition-opacity hover:bg-tint hover:text-fg-muted group-hover:opacity-100 focus:opacity-100"
                            title="Copy answer to clipboard"
                            aria-label="Copy answer"
                          >
                            {copiedMsgId === m.id ? (
                              <>
                                <Check size={10} className="text-accent" />
                                Copied
                              </>
                            ) : (
                              <>
                                <Copy size={10} />
                                Copy
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Input */}
            <div className="border-t border-line px-4 py-3">
              <div className="flex items-center gap-2">
                <input
                  ref={inputRef}
                  type="text"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      ask(question);
                    }
                  }}
                  placeholder="Ask anything about this log…"
                  disabled={loading}
                  autoFocus
                  className="flex-1 rounded-md border border-line bg-surface-1 px-3 py-2 text-[12px] text-fg outline-none placeholder:text-fg-ghost focus:border-accent disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => ask(question)}
                  disabled={!question.trim() || loading}
                  className="rounded-md bg-accent p-2 text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
                  aria-label="Send"
                >
                  <Send size={13} />
                </button>
              </div>
            </div>
      </div>
    </div>
  );
}
