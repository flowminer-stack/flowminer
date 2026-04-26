"""Task mining pattern discovery.

Given a set of TaskEvent rows for a project, reconstruct per-user
sessions and find the most frequent short sequences of (app, event_type)
pairs. Each frequent sequence becomes a TaskPattern.

This is intentionally simple — a windowed n-gram counter that ignores
high-frequency noise events (mouse moves, redundant focus changes) and
merges consecutive same-app events. For a full N-gram discovery engine
we'd use suffix-array frequency counting, but this is good enough for
a first cut and matches how StereoLOGIC / Workfellow describe their
own task-mining miners.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Iterable

_NOISE_EVENTS = {"mouse_move", "focus_tick", "idle", "heartbeat"}


def _canonicalize(event: dict) -> tuple[str, str]:
    """Collapse an event to a canonical (app, event_type) tuple used for
    sequence matching. Returns None to drop the event entirely."""
    et = (event.get("event_type") or "").lower()
    if et in _NOISE_EVENTS:
        return None  # type: ignore[return-value]
    app = (event.get("application") or "unknown").split("/")[-1].lower()
    return (app, et)


def mine_patterns(
    events: Iterable[dict],
    *,
    min_sequence_length: int = 3,
    max_sequence_length: int = 8,
    min_frequency: int = 3,
    session_gap_seconds: int = 120,
) -> list[dict]:
    """Discover frequent task-like sequences from a stream of task events.

    Args:
        events: iterable of dicts with keys ``ts``, ``event_type``,
            ``application``, ``recording_id``, ``user_id``.
        min_sequence_length: shortest n-gram to consider.
        max_sequence_length: longest n-gram to consider.
        min_frequency: sequences seen at least this many times are kept.
        session_gap_seconds: if two consecutive events are more than this
            many seconds apart we consider the session broken and start
            a new subsequence.

    Returns:
        List of pattern dicts with the frequency, sample recordings,
        unique users, and an `automatable_score`.
    """
    # Bucket events per (recording, user) and sort
    buckets: dict[tuple, list[dict]] = defaultdict(list)
    for ev in events:
        rid = ev.get("recording_id")
        if rid is None:
            continue
        buckets[rid].append(ev)

    # Count n-grams across all sessions
    ngram_counts: Counter[tuple] = Counter()
    ngram_recordings: dict[tuple, set] = defaultdict(set)
    ngram_users: dict[tuple, set] = defaultdict(set)
    ngram_durations: dict[tuple, list[float]] = defaultdict(list)

    for rid, events_for_recording in buckets.items():
        # Sort by timestamp
        try:
            events_for_recording.sort(key=lambda e: e.get("ts") or 0)
        except Exception:
            pass

        # Canonicalize + merge consecutive duplicates
        seq: list[tuple] = []
        seq_ts: list[float] = []
        last: tuple | None = None
        for ev in events_for_recording:
            canon = _canonicalize(ev)
            if canon is None:
                continue
            if canon == last:
                continue
            ts = ev.get("ts")
            try:
                ts_f = ts.timestamp() if hasattr(ts, "timestamp") else float(ts or 0)
            except Exception:
                ts_f = 0.0
            # Session break
            if seq and ts_f and seq_ts and (ts_f - seq_ts[-1]) > session_gap_seconds:
                # Emit n-grams from the current session then reset
                _emit_ngrams(
                    seq,
                    seq_ts,
                    rid,
                    ev.get("user_id"),
                    ngram_counts,
                    ngram_recordings,
                    ngram_users,
                    ngram_durations,
                    min_sequence_length,
                    max_sequence_length,
                )
                seq = []
                seq_ts = []
            seq.append(canon)
            seq_ts.append(ts_f)
            last = canon

        _emit_ngrams(
            seq,
            seq_ts,
            rid,
            events_for_recording[-1].get("user_id") if events_for_recording else None,
            ngram_counts,
            ngram_recordings,
            ngram_users,
            ngram_durations,
            min_sequence_length,
            max_sequence_length,
        )

    # Filter to frequent sequences
    patterns: list[dict] = []
    for ngram, count in ngram_counts.most_common():
        if count < min_frequency:
            break  # Counter.most_common yields in decreasing order
        durations = ngram_durations.get(ngram, [])
        avg_dur = sum(durations) / len(durations) if durations else 0
        # Automatable score: high for short deterministic sequences that
        # occur often across few users (looks scripted).
        users = ngram_users.get(ngram, set())
        automatable = 1.0 - (len(users) / max(count, 1))
        automatable = max(0.0, min(1.0, automatable))
        patterns.append(
            {
                "sequence": [list(step) for step in ngram],
                "frequency": count,
                "avg_duration_sec": int(avg_dur),
                "sample_recording_ids": [str(r) for r in list(ngram_recordings[ngram])[:5]],
                "unique_users": len(users),
                "automatable_score": round(automatable, 2),
            }
        )

    return patterns


def _emit_ngrams(
    seq: list[tuple],
    seq_ts: list[float],
    rid,
    user_id,
    counts: Counter,
    recordings: dict,
    users: dict,
    durations: dict,
    min_len: int,
    max_len: int,
) -> None:
    if len(seq) < min_len:
        return
    for n in range(min_len, min(max_len, len(seq)) + 1):
        for i in range(len(seq) - n + 1):
            key = tuple(seq[i : i + n])
            counts[key] += 1
            recordings[key].add(rid)
            if user_id is not None:
                users[key].add(user_id)
            if seq_ts[i + n - 1] and seq_ts[i]:
                durations[key].append(seq_ts[i + n - 1] - seq_ts[i])
