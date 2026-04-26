import { useEffect, useState } from 'react';
import { MessageSquare, Send, Trash2 } from 'lucide-react';
import { annotations as annotationsApi } from '@/api/client';
import type { Annotation } from '@/types';

// Signavio-style threaded comments anchored to a specific activity
// node or DFG edge. Uses the existing /annotations endpoint — we
// just filter by activity_name (or edge pair) on the client since
// the API already returns per-log lists.

interface CommentThreadProps {
  eventLogId: string;
  projectId?: string;
  activityName?: string;
  edgeSource?: string;
  edgeTarget?: string;
}

export default function CommentThread({
  eventLogId,
  projectId,
  activityName,
  edgeSource,
  edgeTarget,
}: CommentThreadProps) {
  const [items, setItems] = useState<Annotation[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);

  const reload = () => {
    setLoading(true);
    annotationsApi
      .list(eventLogId)
      .then((all) => {
        setItems(
          all.filter((a) => {
            if (activityName) return a.activity_name === activityName;
            if (edgeSource && edgeTarget)
              return a.edge_source === edgeSource && a.edge_target === edgeTarget;
            return false;
          }),
        );
      })
      .finally(() => setLoading(false));
  };

  useEffect(reload, [eventLogId, activityName, edgeSource, edgeTarget]);

  const post = async () => {
    if (!text.trim() || !projectId) return;
    setPosting(true);
    try {
      await annotationsApi.create({
        project_id: projectId,
        event_log_id: eventLogId,
        activity_name: activityName ?? null,
        edge_source: edgeSource ?? null,
        edge_target: edgeTarget ?? null,
        content: text.trim(),
      });
      setText('');
      reload();
    } finally {
      setPosting(false);
    }
  };

  const remove = async (id: string) => {
    await annotationsApi.delete(id);
    reload();
  };

  return (
    <div className="mt-3 rounded-lg border border-line bg-surface-1 p-3">
      <div className="mb-2 flex items-center gap-2">
        <MessageSquare size={12} className="text-accent" />
        <span className="text-[11px] font-semibold text-fg">
          Comments{' '}
          <span className="font-normal text-fg-faint">({items.length})</span>
        </span>
      </div>
      {loading ? (
        <p className="text-[11px] text-fg-muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-[11px] text-fg-ghost">
          No comments yet. Add one to start a thread on this {activityName ? 'activity' : 'edge'}.
        </p>
      ) : (
        <div className="mb-2 max-h-40 space-y-1.5 overflow-y-auto">
          {items.map((a) => (
            <div
              key={a.id}
              className="group rounded-md border border-line bg-surface-0 px-2 py-1.5"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="flex-1 text-[11px] text-fg-secondary">{a.content}</p>
                <button
                  type="button"
                  onClick={() => remove(a.id)}
                  className="shrink-0 text-fg-ghost opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                  title="Delete comment"
                >
                  <Trash2 size={10} />
                </button>
              </div>
              <p className="mt-0.5 text-[9px] text-fg-faint">
                {new Date(a.created_at).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
      )}
      {projectId && (
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') post();
            }}
            placeholder="Add a comment — @mentions supported"
            className="flex-1 bg-transparent text-[11px] text-fg outline-none placeholder:text-fg-ghost"
          />
          <button
            type="button"
            onClick={post}
            disabled={!text.trim() || posting}
            className="rounded p-1 text-fg-muted transition-colors hover:bg-tint hover:text-accent disabled:opacity-40"
            title="Post comment (Enter)"
          >
            <Send size={11} />
          </button>
        </div>
      )}
    </div>
  );
}
