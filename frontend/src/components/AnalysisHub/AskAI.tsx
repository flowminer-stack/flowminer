import { useRef, useState, useEffect } from 'react';
import { Send, Sparkles, Zap, User as UserIcon, Bot } from 'lucide-react';
import Markdown from '@/components/common/Markdown';
import clsx from 'clsx';
import { ai as aiApi } from '@/api/client';
import type { ChatToolStartEvent, ChatToolResultEvent } from '@/api/client';
import { useFilterStore } from '@/store/filterStore';
import {
  ToolResultRender,
  type ToolCallState,
} from '@/components/AI/ChatCharts';

interface Props {
  eventLogId: string;
}

type Role = 'user' | 'assistant';

interface Message {
  id: number;
  role: Role;
  text: string;
  streaming?: boolean;
  toolCalls?: ToolCallState[];
}

type Mode = 'chat' | 'agent';

const SUGGESTIONS = [
  'Which activities are the biggest bottleneck and why?',
  'What are the top 3 variants, and how different are they?',
  'Where should we focus automation first?',
  'Summarize the health of this process in 3 bullets.',
  'Are there any compliance or 4-eyes violations?',
  'What would a good KPI dashboard for this process look like?',
];

let _msgCounter = 0;

export default function AskAI({ eventLogId }: Props) {
  const [mode, setMode] = useState<Mode>('chat');
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

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

    const filterChips = useFilterStore.getState().chips;
    const disabled = useFilterStore.getState().disabled;
    const active = filterChips.filter((c) => !disabled[c.id]);
    const filterPreamble =
      active.length > 0
        ? `Current analysis filters: ${active.map((c) => c.label).join(' · ')}. Take these into account.\n\n`
        : '';
    const enrichedText = filterPreamble + text;

    try {
      if (mode === 'chat') {
        await aiApi.chatStream(eventLogId, enrichedText, {
          onChunk: (chunk: string) => {
            setMessages((m) =>
              m.map((msg) =>
                msg.id === assistantMsg.id
                  ? { ...msg, text: msg.text + chunk }
                  : msg,
              ),
            );
          },
          onToolStart: (event: ChatToolStartEvent) => {
            setMessages((m) =>
              m.map((msg) => {
                if (msg.id !== assistantMsg.id) return msg;
                const existing = msg.toolCalls ?? [];
                if (existing.some((tc) => tc.id === event.id)) return msg;
                return {
                  ...msg,
                  toolCalls: [
                    ...existing,
                    { id: event.id, name: event.name, args: event.args, result: null },
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
                  toolCalls: existing.map((tc) =>
                    tc.id === event.id ? { ...tc, result: event.result } : tc,
                  ),
                };
              }),
            );
          },
        });
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantMsg.id ? { ...msg, streaming: false } : msg,
          ),
        );
      } else {
        const result = await aiApi.agentRun(eventLogId, enrichedText);
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantMsg.id
              ? {
                  ...msg,
                  text: result.text || '(no response)',
                  streaming: false,
                  toolCalls: result.tool_calls?.map((tc) => ({
                    id: tc.name + Math.random(),
                    name: tc.name,
                    args: tc.args,
                    result: null,
                  })),
                }
              : msg,
          ),
        );
      }
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

  return (
    <div className="flex h-full flex-col space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-fg-muted">
          Ask a natural-language question — the LLM has the log's summary, variants, bottlenecks, and insights as context.
        </p>
        <div className="flex overflow-hidden rounded-md border border-line">
          <button
            onClick={() => setMode('chat')}
            className={clsx(
              'flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium transition-colors',
              mode === 'chat' ? 'bg-accent text-white' : 'text-fg-muted hover:bg-tint',
            )}
            title="Single-turn chat with pre-loaded log context"
          >
            <Sparkles size={12} />
            Chat
          </button>
          <button
            onClick={() => setMode('agent')}
            className={clsx(
              'flex items-center gap-1 border-l border-line px-2.5 py-1 text-[10px] font-medium transition-colors',
              mode === 'agent' ? 'bg-accent text-white' : 'text-fg-muted hover:bg-tint',
            )}
            title="Agent mode: LLM calls analysis tools as needed"
          >
            <Zap size={12} />
            Agent
          </button>
        </div>
      </div>

      {messages.length === 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => ask(s)}
              className="rounded-full border border-line px-2.5 py-1 text-[10px] text-fg-muted hover:bg-tint hover:text-fg"
            >
              {s}
            </button>
          ))}
        </div>
      ) : (
        <div
          ref={threadRef}
          className="max-h-[480px] min-h-[240px] flex-1 space-y-3 overflow-y-auto rounded-lg border border-line bg-surface-1 p-3"
        >
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} eventLogId={eventLogId} />
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ask(question)}
          placeholder={
            mode === 'chat'
              ? 'e.g. What are the top bottlenecks and why?'
              : 'e.g. Call the tools needed to rank automation candidates.'
          }
          disabled={loading}
          className="input flex-1"
        />
        <button
          onClick={() => ask(question)}
          disabled={loading || !question.trim()}
          className="btn-primary flex items-center gap-1.5 disabled:opacity-50"
        >
          <Send size={13} />
          {loading ? '…' : 'Ask'}
        </button>
        {messages.length > 0 && (
          <button
            onClick={() => setMessages([])}
            disabled={loading}
            className="rounded-md border border-line px-3 text-[11px] text-fg-muted hover:bg-tint hover:text-fg disabled:opacity-50"
            title="Clear conversation"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ message, eventLogId }: { message: Message; eventLogId: string }) {
  const isUser = message.role === 'user';
  return (
    <div className={clsx('flex gap-2', isUser && 'flex-row-reverse')}>
      <div
        className={clsx(
          'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full',
          isUser ? 'bg-accent text-white' : 'bg-tint text-fg-secondary',
        )}
      >
        {isUser ? <UserIcon size={12} /> : <Bot size={12} />}
      </div>
      <div className={clsx('flex-1 space-y-1.5', isUser && 'text-right')}>
        {/* Inline chart / tool results */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mb-1 space-y-1">
            {message.toolCalls.map((tc) => (
              <ToolResultRender key={tc.id} tc={tc} eventLogId={eventLogId} />
            ))}
          </div>
        )}
        <div
          className={clsx(
            'inline-block max-w-full rounded-lg px-3 py-2 text-[12px] leading-relaxed',
            isUser ? 'bg-accent/10 text-fg' : 'bg-surface-2 text-fg-secondary',
          )}
        >
          {message.text ? (
            isUser ? (
              <span className="whitespace-pre-wrap">{message.text}</span>
            ) : (
              <Markdown text={message.text} variant="compact" />
            )
          ) : message.streaming ? (
            <span>▊</span>
          ) : null}
          {message.streaming && message.text && (
            <span className="ml-0.5 inline-block animate-pulse">▊</span>
          )}
        </div>
      </div>
    </div>
  );
}
