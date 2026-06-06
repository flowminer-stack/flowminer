"""
Predictive process monitoring: remaining-time regression and outcome
classification on in-flight cases.

Unlike the earlier prefix-average stub, this uses real sklearn models
trained on features engineered from completed cases:
    [prefix_length, elapsed_seconds, unique_activities_so_far,
     hour_of_day, day_of_week, rework_count, last_activity (one-hot)]

GradientBoostingRegressor drives the remaining-time prediction;
RandomForestClassifier drives the slow-vs-fast outcome prediction.

Trained models are now persisted to disk (see ``app.services.model_store``)
keyed by ``(event_log_id, kind)`` plus a content hash of the log, so repeat
requests — and especially the close-the-loop alarm layer that re-scores open
cases — reuse a fitted model instead of refitting every call. Passing
``event_log_id=None`` falls back to the original train-on-request behaviour.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

import numpy as np
import pandas as pd

from app.services import model_store
from app.services.ingestion import ACTIVITY_COL, CASE_COL, TIMESTAMP_COL
from app.services.rust_accel import compute_prefix_features as _rs_prefix_features

logger = logging.getLogger(__name__)


# ─── Feature engineering ─────────────────────────────────────────────────────


def _extract_prefix_features(df: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    """Build one row per (case_id, prefix_length) with engineered features.

    For completed cases, ``remaining_seconds`` is the target for the
    remaining-time regressor. For outcome classification, we label cases
    as "slow" if their total duration is above the median of completed
    cases — so the classifier can be trained on prefixes of completed
    cases alone.
    """
    # Rust fast path: one native pass instead of the Python triple loop +
    # ~1.3M-dict materialisation (all four predictive endpoints share this).
    if TIMESTAMP_COL in df.columns:
        try:
            rs = _rs_prefix_features(df)
        except Exception as e:  # noqa: BLE001 - never let accel break prediction
            logger.warning("Rust prefix features failed (%s); using pandas path", e)
            rs = None
        if rs is not None:
            return rs

    rows: list[dict[str, Any]] = []
    activity_tokens: set[str] = set()

    # Stable sort by [case, timestamp] so events tied on a timestamp keep their
    # ingestion order — deterministic and matching the Rust fast path. (A plain
    # timestamp sort with the default quicksort makes prefixes non-reproducible
    # on day-granularity logs.)
    grouped = df.sort_values(
        [CASE_COL, TIMESTAMP_COL], kind="mergesort"
    ).groupby(CASE_COL, sort=False)
    case_infos = []

    for case_id, group in grouped:
        activities = group[ACTIVITY_COL].tolist()
        timestamps = group[TIMESTAMP_COL].tolist()
        n_events = len(activities)
        if n_events < 2:
            continue

        try:
            total_duration = (timestamps[-1] - timestamps[0]).total_seconds()
        except Exception:
            continue

        activity_tokens.update(activities)
        case_infos.append((str(case_id), activities, timestamps, total_duration))

    if not case_infos:
        return pd.DataFrame(), []

    # Build feature rows at each prefix length
    for case_id, activities, timestamps, total_duration in case_infos:
        for pl in range(1, len(activities)):
            elapsed = (timestamps[pl - 1] - timestamps[0]).total_seconds()
            remaining = total_duration - elapsed
            prefix_activities = activities[:pl]
            unique_so_far = len(set(prefix_activities))
            rework_count = len(prefix_activities) - unique_so_far
            last_ts = timestamps[pl - 1]

            row: dict[str, Any] = {
                "case_id": case_id,
                "prefix_length": pl,
                "elapsed_seconds": float(elapsed),
                "remaining_seconds": float(remaining),
                "total_seconds": float(total_duration),
                "unique_activities_so_far": unique_so_far,
                "rework_count": rework_count,
                "hour_of_day": int(getattr(last_ts, "hour", 0) or 0),
                "day_of_week": int(getattr(last_ts, "dayofweek", getattr(last_ts, "weekday", lambda: 0)()) if hasattr(last_ts, "dayofweek") else 0),
                "last_activity": activities[pl - 1],
                "is_last_prefix": pl == len(activities) - 1,
            }
            rows.append(row)

    feats = pd.DataFrame(rows)
    return feats, sorted(activity_tokens)


def _onehot_activity(feats: pd.DataFrame, activities: list[str]) -> np.ndarray:
    """Convert the ``last_activity`` column into a one-hot matrix using a
    fixed column order (so the shape is stable across calls)."""
    if feats.empty or not activities:
        return np.zeros((len(feats), 0))
    index_by_act = {act: i for i, act in enumerate(activities)}
    out = np.zeros((len(feats), len(activities)))
    for r, act in enumerate(feats["last_activity"].tolist()):
        col = index_by_act.get(act)
        if col is not None:
            out[r, col] = 1
    return out


def _assemble_X(feats: pd.DataFrame, activities: list[str]) -> np.ndarray:
    numeric_cols = [
        "prefix_length",
        "elapsed_seconds",
        "unique_activities_so_far",
        "rework_count",
        "hour_of_day",
        "day_of_week",
    ]
    if feats.empty:
        return np.zeros((0, len(numeric_cols) + len(activities)))
    num = feats[numeric_cols].to_numpy(dtype=float)
    cat = _onehot_activity(feats, activities)
    return np.concatenate([num, cat], axis=1)


# ─── Predictive service ──────────────────────────────────────────────────────


class PredictiveService:
    # ── Model training (cached) ──────────────────────────────────────────────
    #
    # Each ``_train_*`` returns a payload dict bundling the fitted estimator
    # with everything needed to score new prefixes later (the activity
    # vocabulary, any threshold, the class list), plus a ``model_info`` block
    # and a ``metrics`` block. The public ``predict_*`` methods call into
    # ``_get_or_train_*`` which persists/reuses the payload via model_store.

    def _train_remaining_time(self, df: pd.DataFrame) -> dict | None:
        feats, activities = _extract_prefix_features(df)
        if feats.empty or len(feats) < 10:
            return None

        X = _assemble_X(feats, activities)
        y = feats["remaining_seconds"].to_numpy(dtype=float)

        try:
            from sklearn.ensemble import GradientBoostingRegressor
            from sklearn.metrics import mean_absolute_error
            from sklearn.model_selection import KFold, cross_val_predict
        except ImportError:
            return None

        def _new_model() -> GradientBoostingRegressor:
            return GradientBoostingRegressor(
                n_estimators=150, max_depth=4, learning_rate=0.05, random_state=42,
            )

        # Cache a full-data model for genuinely-unseen future prefixes; report
        # MAE and display per-row predictions from OUT-OF-FOLD (cross-fitted)
        # estimates so the shown numbers are honestly out-of-sample.
        model = _new_model()
        try:
            model.fit(X, y)
        except Exception as e:
            logger.warning("GBR fit failed: %s", e)
            return None

        n_splits = min(5, len(y))
        if len(y) > 50_000:
            n_splits = min(n_splits, 3)

        oof_map: dict[str, float] = {}
        oof_flag = False
        oof_pred: np.ndarray | None = None
        if n_splits >= 2:
            try:
                cv = KFold(n_splits=n_splits, shuffle=True, random_state=42)
                oof_pred = cross_val_predict(
                    _new_model(), X, y, cv=cv, method="predict", n_jobs=1
                )
                oof_flag = True
            except Exception as e:  # noqa: BLE001 - degrade to in-sample, never crash
                logger.warning("remaining-time cross_val_predict failed: %s", e)
                oof_pred = None
                oof_flag = False

        if oof_flag and oof_pred is not None:
            oof_pred = np.where(np.isfinite(oof_pred), oof_pred, 0.0)
            mae_val = float(mean_absolute_error(y, oof_pred))
            resid_std = float(np.std(y - oof_pred))
            case_ids = feats["case_id"].tolist()
            prefix_lengths = feats["prefix_length"].tolist()
            for cid, pl, p in zip(case_ids, prefix_lengths, oof_pred):
                oof_map[f"{cid}::{int(pl)}"] = float(p)
        else:
            in_sample = model.predict(X)
            mae_val = float(mean_absolute_error(y, in_sample)) if len(y) else 0.0
            resid_std = float(np.std(y - in_sample)) if len(y) else 0.0

        return {
            "model": model,
            "activities": activities,
            "resid_std": resid_std,
            "feature_count": int(X.shape[1]),
            "oof_remaining_seconds": oof_map,
            "metrics": {"validation_mae_seconds": round(mae_val, 1), "oof": bool(oof_flag)},
            "model_info": {
                "method": "gradient_boosting_regressor",
                "n_estimators": 150,
                "max_depth": 4,
                "training_samples": int(len(X)),
                "cv_splits": int(n_splits) if oof_flag else 0,
                "oof": bool(oof_flag),
                "validation_mae_seconds": round(mae_val, 1),
                "feature_count": int(X.shape[1]),
            },
        }

    def _get_or_train_remaining_time(
        self, df: pd.DataFrame, event_log_id: Any | None
    ) -> dict | None:
        """Return a remaining-time payload, reusing the on-disk model if the
        log is unchanged. ``event_log_id=None`` always trains fresh."""
        if event_log_id is None:
            return self._train_remaining_time(df)
        chash = model_store.content_hash(df)
        cached = model_store.load_model(event_log_id, "remaining_time", content_hash=chash)
        if cached is not None:
            return cached
        payload = self._train_remaining_time(df)
        if payload is not None:
            model_store.save_model(
                event_log_id, "remaining_time", payload,
                content_hash=chash,
                n_cases=int(df[CASE_COL].nunique()) if CASE_COL in df.columns else None,
                metrics=payload.get("metrics"),
            )
        return payload

    def predict_remaining_time(
        self, df: pd.DataFrame, event_log_id: Any | None = None
    ) -> dict:
        """Apply the (cached) GradientBoostingRegressor to the CURRENT state of
        every case. Trains and persists the model on first use; subsequent
        calls for an unchanged log reuse it.

        The displayed per-case ``predicted_remaining_seconds`` are out-of-fold
        (cross-fitted) for prefixes the model trained on — i.e. honestly
        out-of-sample and consistent with the reported MAE. Prefixes not in the
        out-of-fold map (or when CV was skipped on a tiny log) fall back to the
        full-data model's prediction.

        Returns top 200 predictions ordered by predicted remaining time.
        """
        feats, activities_now = _extract_prefix_features(df)
        if feats.empty or len(feats) < 10:
            return {
                "predictions": [],
                "model_info": {"method": "gbr", "reason": "insufficient data", "samples": 0},
            }

        payload = self._get_or_train_remaining_time(df, event_log_id)
        if payload is None:
            return {
                "predictions": [],
                "model_info": {"method": "gbr", "reason": "model unavailable (insufficient data or sklearn missing)"},
            }

        model = payload["model"]
        activities = payload["activities"]
        stds = payload.get("resid_std", 0.0)
        oof_map = payload.get("oof_remaining_seconds") or {}

        # Latest prefix per case — what we want to predict on
        latest = (
            feats.sort_values("prefix_length")
            .groupby("case_id")
            .tail(1)
            .reset_index(drop=True)
        )
        X_latest = _assemble_X(latest, activities)
        preds = model.predict(X_latest)

        predictions = []
        for i, row in latest.iterrows():
            # Prefer the out-of-fold (out-of-sample) estimate when this row was
            # part of training; only fall back to the full-data model otherwise.
            oof_val = oof_map.get(f"{row['case_id']}::{int(row['prefix_length'])}")
            raw = oof_val if oof_val is not None else float(preds[i])
            avg_rem = float(max(0.0, raw))
            predictions.append(
                {
                    "case_id": row["case_id"],
                    "prefix_length": int(row["prefix_length"]),
                    "elapsed_seconds": float(row["elapsed_seconds"]),
                    "predicted_remaining_seconds": round(avg_rem, 1),
                    "confidence_low": round(max(0.0, avg_rem - stds), 1),
                    "confidence_high": round(avg_rem + stds, 1),
                    "last_activity": row["last_activity"],
                }
            )
        predictions.sort(key=lambda p: p["predicted_remaining_seconds"], reverse=True)

        return {
            "predictions": predictions[:200],
            "model_info": payload["model_info"],
        }

    def _train_outcome(self, df: pd.DataFrame, sla_threshold: float | None) -> dict | None:
        feats, activities = _extract_prefix_features(df)
        if feats.empty or len(feats) < 20:
            return None

        # Label every prefix by whether its total case duration is slow
        threshold = sla_threshold if sla_threshold else float(feats["total_seconds"].median())
        y = (feats["total_seconds"] > threshold).astype(int).to_numpy()
        X = _assemble_X(feats, activities)

        try:
            from sklearn.ensemble import RandomForestClassifier
            from sklearn.metrics import roc_auc_score
            from sklearn.model_selection import StratifiedKFold, cross_val_predict
        except ImportError:
            return None

        if y.sum() == 0 or y.sum() == len(y):
            return {
                "model": None,
                "activities": activities,
                "threshold": float(threshold),
                "degenerate": True,
                "metrics": {},
                "model_info": {"method": "rf", "reason": "degenerate label (all one class)"},
            }

        def _new_model() -> RandomForestClassifier:
            return RandomForestClassifier(
                n_estimators=200, max_depth=8, random_state=42, n_jobs=1, class_weight="balanced",
            )

        # The cached estimator is fit on ALL rows so genuinely-unseen future
        # prefixes get a full-data model. The reported AUC and the per-row
        # scores we display, however, are computed from OUT-OF-FOLD (cross-
        # fitted) predictions so they're honestly out-of-sample.
        model = _new_model()
        try:
            model.fit(X, y)
        except Exception as e:
            logger.warning("RF fit failed: %s", e)
            return None

        # Choose CV folds: bounded for speed (training is cached per-log), and
        # capped by the smallest class so every fold can stratify. Fall back to
        # in-sample scoring when the data is too small/degenerate for CV.
        smallest_class = int(min(np.bincount(y)))
        n_splits = min(5, smallest_class)
        if len(y) > 50_000:
            n_splits = min(n_splits, 3)

        oof_map: dict[str, float] = {}
        oof_flag = False
        oof_proba: np.ndarray | None = None
        if n_splits >= 2:
            try:
                cv = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=42)
                oof_proba = cross_val_predict(
                    _new_model(), X, y, cv=cv, method="predict_proba", n_jobs=1
                )[:, 1]
                oof_flag = True
            except Exception as e:  # noqa: BLE001 - degrade to in-sample, never crash
                logger.warning("outcome cross_val_predict failed: %s", e)
                oof_proba = None
                oof_flag = False

        if oof_flag and oof_proba is not None:
            try:
                auc = float(roc_auc_score(y, oof_proba))
            except Exception:  # noqa: BLE001
                auc = 0.0
            case_ids = feats["case_id"].tolist()
            prefix_lengths = feats["prefix_length"].tolist()
            for cid, pl, p in zip(case_ids, prefix_lengths, oof_proba):
                val = float(p)
                if not np.isfinite(val):
                    val = 0.0
                oof_map[f"{cid}::{int(pl)}"] = val
        else:
            # Too few samples/classes for CV → honest in-sample fallback.
            try:
                in_sample = model.predict_proba(X)[:, 1]
                auc = float(roc_auc_score(y, in_sample))
            except Exception:  # noqa: BLE001
                auc = 0.0

        return {
            "model": model,
            "activities": activities,
            "threshold": float(threshold),
            "overall_slow_rate": round(float(y.mean() * 100), 1),
            "feature_count": int(X.shape[1]),
            "oof_breach_probability": oof_map,
            "metrics": {"validation_auc": round(auc, 3), "oof": bool(oof_flag)},
            "model_info": {
                "method": "random_forest_classifier",
                "n_estimators": 200,
                "max_depth": 8,
                "training_samples": int(len(X)),
                "cv_splits": int(n_splits) if oof_flag else 0,
                "oof": bool(oof_flag),
                "validation_auc": round(auc, 3),
                "feature_count": int(X.shape[1]),
            },
        }

    def _get_or_train_outcome(
        self, df: pd.DataFrame, sla_threshold: float | None, event_log_id: Any | None
    ) -> dict | None:
        """Return an outcome payload, reusing the on-disk model if the log AND
        threshold are unchanged. The threshold is folded into both the cache
        ``kind`` and the content hash so a different SLA retrains."""
        if event_log_id is None:
            return self._train_outcome(df, sla_threshold)
        thr_key = "median" if sla_threshold is None else f"sla{sla_threshold:g}"
        kind = f"outcome__{thr_key}"
        chash = model_store.content_hash(df) + ":" + thr_key
        cached = model_store.load_model(event_log_id, kind, content_hash=chash)
        if cached is not None:
            return cached
        payload = self._train_outcome(df, sla_threshold)
        if payload is not None:
            model_store.save_model(
                event_log_id, kind, payload,
                content_hash=chash,
                n_cases=int(df[CASE_COL].nunique()) if CASE_COL in df.columns else None,
                metrics=payload.get("metrics"),
            )
        return payload

    def predict_outcome(
        self,
        df: pd.DataFrame,
        sla_threshold: float | None = None,
        event_log_id: Any | None = None,
    ) -> dict:
        """Apply the (cached) RandomForestClassifier predicting slow-vs-fast
        cases. Cases are labelled slow if total duration > SLA threshold (or
        the median of completed cases when unspecified). The fitted model is
        persisted per (log, threshold) and reused while the log is unchanged.

        The displayed per-case ``risk_score`` is the out-of-fold (cross-fitted)
        breach probability for prefixes the model trained on — honestly
        out-of-sample and consistent with the reported AUC. Prefixes outside the
        out-of-fold map (or when CV was skipped on a tiny log) fall back to the
        full-data model's ``predict_proba``."""
        feats, _activities_now = _extract_prefix_features(df)
        if feats.empty or len(feats) < 20:
            return {
                "predictions": [],
                "threshold_seconds": 0,
                "model_info": {"method": "rf", "reason": "insufficient data"},
            }

        payload = self._get_or_train_outcome(df, sla_threshold, event_log_id)
        if payload is None:
            return {"predictions": [], "model_info": {"method": "none", "reason": "sklearn unavailable"}}
        if payload.get("degenerate") or payload.get("model") is None:
            return {
                "predictions": [],
                "threshold_seconds": payload.get("threshold", 0),
                "model_info": payload.get(
                    "model_info", {"method": "rf", "reason": "degenerate label (all one class)"}
                ),
            }

        model = payload["model"]
        activities = payload["activities"]
        threshold = payload["threshold"]
        oof_map = payload.get("oof_breach_probability") or {}

        latest = feats.sort_values("prefix_length").groupby("case_id").tail(1).reset_index(drop=True)
        X_latest = _assemble_X(latest, activities)
        risk = model.predict_proba(X_latest)[:, 1]

        predictions = []
        for i, row in latest.iterrows():
            # Prefer the out-of-fold (out-of-sample) probability when this row
            # was part of training; only fall back to the full-data model.
            oof_val = oof_map.get(f"{row['case_id']}::{int(row['prefix_length'])}")
            risk_score = float(oof_val) if oof_val is not None else float(risk[i])
            predictions.append(
                {
                    "case_id": row["case_id"],
                    "duration_seconds": float(row["total_seconds"]),
                    "is_slow": bool(row["total_seconds"] > threshold),
                    "risk_score": round(risk_score, 3),
                    "risk_label": "high" if risk_score > 0.7 else "medium" if risk_score > 0.4 else "low",
                    "last_activity": row["last_activity"],
                    "prefix_length": int(row["prefix_length"]),
                }
            )

        predictions.sort(key=lambda p: p["risk_score"], reverse=True)

        return {
            "predictions": predictions[:200],
            "threshold_seconds": float(threshold),
            "overall_slow_rate": payload.get("overall_slow_rate"),
            "model_info": payload["model_info"],
        }


    def _train_next_activity(self, df: pd.DataFrame) -> dict | None:
        feats, activities = _extract_prefix_features(df)
        if feats.empty or len(feats) < 20 or len(activities) < 2:
            return None

        # Build the target: for each prefix row, what was the ACTUAL next
        # activity in the same case? We reconstruct that by walking the
        # sorted events per case.
        next_activity_by_case_prefix: dict[tuple[str, int], str] = {}
        sorted_df = df.sort_values(TIMESTAMP_COL).groupby(CASE_COL, sort=False)
        for case_id, group in sorted_df:
            acts = group[ACTIVITY_COL].tolist()
            for pl in range(1, len(acts)):
                if pl < len(acts):
                    next_activity_by_case_prefix[(str(case_id), pl)] = acts[pl]

        # Attach target to feats
        feats = feats.copy()
        feats["next_activity"] = feats.apply(
            lambda row: next_activity_by_case_prefix.get((row["case_id"], int(row["prefix_length"]))),
            axis=1,
        )
        # Drop rows that are the last prefix of their case (no "next")
        train_df = feats[feats["next_activity"].notna()]
        if len(train_df) < 10:
            return None

        X = _assemble_X(train_df, activities)
        y = train_df["next_activity"].to_numpy()

        try:
            from sklearn.ensemble import RandomForestClassifier
            from sklearn.metrics import accuracy_score
            from sklearn.model_selection import train_test_split
        except ImportError:
            return None

        # Need at least 2 classes
        unique_targets = list(set(y.tolist()))
        if len(unique_targets) < 2:
            return {
                "model": None,
                "activities": activities,
                "classes": unique_targets,
                "degenerate": True,
                "metrics": {},
                "model_info": {"reason": "only one possible next activity"},
            }

        try:
            X_train, X_val, y_train, y_val = train_test_split(X, y, test_size=0.2, random_state=42)
        except ValueError:
            X_train, X_val, y_train, y_val = X, X, y, y

        model = RandomForestClassifier(n_estimators=200, max_depth=10, random_state=42, n_jobs=1)
        try:
            model.fit(X_train, y_train)
        except Exception as e:
            logger.warning("next-activity RF fit failed: %s", e)
            return None

        try:
            val_acc = float(accuracy_score(y_val, model.predict(X_val)))
        except Exception:
            val_acc = 0.0

        classes = list(model.classes_)
        return {
            "model": model,
            "activities": activities,
            "classes": classes,
            "metrics": {"validation_accuracy": round(val_acc, 3)},
            "model_info": {
                "method": "random_forest_classifier",
                "n_estimators": 200,
                "max_depth": 10,
                "training_samples": int(len(X_train)),
                "validation_samples": int(len(X_val)),
                "validation_accuracy": round(val_acc, 3),
                "num_classes": len(classes),
            },
        }

    def _get_or_train_next_activity(
        self, df: pd.DataFrame, event_log_id: Any | None
    ) -> dict | None:
        """Return a next-activity payload, reusing the on-disk model when the
        log is unchanged. ``event_log_id=None`` always trains fresh."""
        if event_log_id is None:
            return self._train_next_activity(df)
        chash = model_store.content_hash(df)
        cached = model_store.load_model(event_log_id, "next_activity", content_hash=chash)
        if cached is not None:
            return cached
        payload = self._train_next_activity(df)
        if payload is not None:
            model_store.save_model(
                event_log_id, "next_activity", payload,
                content_hash=chash,
                n_cases=int(df[CASE_COL].nunique()) if CASE_COL in df.columns else None,
                metrics=payload.get("metrics"),
            )
        return payload

    def predict_next_activity(
        self, df: pd.DataFrame, event_log_id: Any | None = None
    ) -> dict:
        """Predict the next activity for each running case.

        Approach: for every completed case, emit one training example per
        prefix with features = [last_activity_onehot, prefix_length,
        unique_activities, elapsed_sec, hour_of_day] and target = the
        next activity label. Train a RandomForestClassifier, then score
        each case at its current prefix and return the top-k likely next
        activities with probabilities.

        The fitted model is persisted per log and reused while the log is
        unchanged. This is the third leg of the predictive monitoring trio
        (remaining_time + outcome + next_activity) and is what every
        serious competitor ships.
        """
        feats, activities_now = _extract_prefix_features(df)
        if feats.empty or len(feats) < 20 or len(activities_now) < 2:
            return {
                "predictions": [],
                "model_info": {"method": "rf", "reason": "insufficient data"},
            }

        payload = self._get_or_train_next_activity(df, event_log_id)
        if payload is None:
            return {"predictions": [], "model_info": {"reason": "insufficient data or sklearn unavailable"}}
        if payload.get("degenerate") or payload.get("model") is None:
            return {
                "predictions": [],
                "model_info": payload.get("model_info", {"reason": "only one possible next activity"}),
            }

        model = payload["model"]
        activities = payload["activities"]
        classes = payload["classes"]

        # Predict on the latest prefix per case
        latest = feats.sort_values("prefix_length").groupby("case_id").tail(1).reset_index(drop=True)
        X_latest = _assemble_X(latest, activities)
        probas = model.predict_proba(X_latest)

        predictions = []
        for i, row in latest.iterrows():
            probs = probas[i]
            top_k = sorted(enumerate(probs), key=lambda p: -p[1])[:3]
            predictions.append(
                {
                    "case_id": row["case_id"],
                    "prefix_length": int(row["prefix_length"]),
                    "current_activity": row["last_activity"],
                    "top_predictions": [
                        {"activity": classes[idx], "probability": round(float(p), 3)}
                        for idx, p in top_k
                    ],
                }
            )

        return {
            "predictions": predictions[:200],
            "model_info": payload["model_info"],
        }


    def predict_suffix(
        self,
        df: pd.DataFrame,
        max_suffix_length: int = 20,
    ) -> dict:
        """Predict the full trace suffix for each running case.

        Implements a lightweight adaptation of SuTraN (Wuyts, Vanden
        Broucke, De Weerdt — ICPM 2024, arXiv equivalent): given a
        prefix, generate the entire remaining trace rather than a
        single next step. Where SuTraN uses an encoder-decoder
        transformer trained end-to-end, we chain the existing
        next-activity classifier and remaining-time regressor — trading
        accuracy for being dependency-free.

        The loop:
          1. Take each running case at its current prefix.
          2. Predict the top-1 next activity via RandomForest.
          3. Append it to the prefix, advance elapsed_time by the
             case's average step duration, re-featurize, re-predict.
          4. Stop when we hit ``max_suffix_length`` or a predicted
             activity that historically terminates cases.

        For each predicted step we also record the cumulative
        remaining-time estimate so the frontend can render a timeline.
        """
        feats, activities = _extract_prefix_features(df)
        if feats.empty or len(feats) < 20 or len(activities) < 2:
            return {
                "predictions": [],
                "model_info": {"method": "iterative_suffix", "reason": "insufficient data"},
            }

        # Which activities are "end" activities? An activity is a
        # likely sink if >= 30% of cases that contain it have it as
        # their last event.
        end_counts: dict[str, int] = {}
        act_counts: dict[str, int] = {}
        for _case_id, group in df.sort_values(TIMESTAMP_COL).groupby(CASE_COL, sort=False):
            acts = group[ACTIVITY_COL].tolist()
            if not acts:
                continue
            for a in set(acts):
                act_counts[a] = act_counts.get(a, 0) + 1
            end_counts[acts[-1]] = end_counts.get(acts[-1], 0) + 1
        sink_activities = {
            a for a, ec in end_counts.items()
            if act_counts.get(a, 0) > 0 and ec / act_counts[a] >= 0.3
        }

        # Build training data exactly as predict_next_activity does.
        next_by: dict[tuple[str, int], str] = {}
        sorted_df = df.sort_values(TIMESTAMP_COL).groupby(CASE_COL, sort=False)
        for case_id, group in sorted_df:
            acts = group[ACTIVITY_COL].tolist()
            for pl in range(1, len(acts)):
                next_by[(str(case_id), pl)] = acts[pl]

        feats = feats.copy()
        feats["next_activity"] = feats.apply(
            lambda row: next_by.get((row["case_id"], int(row["prefix_length"]))),
            axis=1,
        )
        train_df = feats[feats["next_activity"].notna()]
        if len(train_df) < 10:
            return {
                "predictions": [],
                "model_info": {"method": "iterative_suffix", "reason": "insufficient labelled prefixes"},
            }

        try:
            from sklearn.ensemble import RandomForestClassifier, GradientBoostingRegressor
        except ImportError:
            return {"predictions": [], "model_info": {"reason": "sklearn unavailable"}}

        X_train = _assemble_X(train_df, activities)
        y_next = train_df["next_activity"].to_numpy()
        if len(set(y_next.tolist())) < 2:
            return {
                "predictions": [],
                "model_info": {"method": "iterative_suffix", "reason": "only one next activity observed"},
            }

        next_model = RandomForestClassifier(
            n_estimators=150, max_depth=12, random_state=42, n_jobs=1,
        )
        try:
            next_model.fit(X_train, y_next)
        except Exception as e:
            logger.warning("suffix next-activity RF fit failed: %s", e)
            return {"predictions": [], "model_info": {"reason": f"fit error: {e}"}}
        classes = list(next_model.classes_)

        # Train a remaining-time regressor on the same features so we
        # can emit per-step time estimates as the suffix unrolls.
        y_remaining = train_df["remaining_seconds"].to_numpy() if "remaining_seconds" in train_df.columns else None
        time_model = None
        if y_remaining is not None and len(y_remaining) >= 10:
            try:
                time_model = GradientBoostingRegressor(
                    n_estimators=120, max_depth=5, random_state=42,
                )
                time_model.fit(X_train, y_remaining)
            except Exception as e:
                logger.warning("suffix remaining-time GBR fit failed: %s", e)
                time_model = None

        # Average per-step duration used for advancing the simulated
        # elapsed time inside the unroll loop.
        avg_step_seconds = 0.0
        if "elapsed_seconds" in feats.columns and "prefix_length" in feats.columns:
            with np.errstate(divide="ignore", invalid="ignore"):
                per_step = feats["elapsed_seconds"] / feats["prefix_length"].clip(lower=1)
                avg_step_seconds = float(per_step.mean() or 0.0)

        # Get the latest prefix per running case and unroll each
        latest = feats.sort_values("prefix_length").groupby("case_id").tail(1).reset_index(drop=True)

        predictions = []
        for _i, row in latest.iterrows():
            suffix: list[dict[str, Any]] = []
            # Start from the current row's feature values; we advance
            # synthetic ones (last_activity, prefix_length, elapsed) per step.
            working_row = row.copy()
            for step in range(max_suffix_length):
                X_step = _assemble_X(pd.DataFrame([working_row]), activities)
                try:
                    probs = next_model.predict_proba(X_step)[0]
                except Exception:
                    break
                top_idx = int(np.argmax(probs))
                predicted = classes[top_idx]
                prob = float(probs[top_idx])

                remaining_est = None
                if time_model is not None:
                    try:
                        remaining_est = float(max(0.0, time_model.predict(X_step)[0]))
                    except Exception:
                        remaining_est = None

                suffix.append({
                    "step": step + 1,
                    "activity": predicted,
                    "probability": round(prob, 3),
                    "remaining_seconds_estimate": (
                        round(remaining_est, 1) if remaining_est is not None else None
                    ),
                })

                if predicted in sink_activities:
                    break

                # Advance synthetic state: increment prefix length and
                # elapsed time; swap last_activity with the prediction.
                working_row["last_activity"] = predicted
                working_row["prefix_length"] = int(working_row["prefix_length"]) + 1
                working_row["elapsed_seconds"] = float(working_row["elapsed_seconds"]) + avg_step_seconds
                if "unique_activities_so_far" in working_row.index:
                    working_row["unique_activities_so_far"] = int(
                        working_row["unique_activities_so_far"]
                    ) + (0 if predicted in set() else 1)

            predictions.append({
                "case_id": row["case_id"],
                "prefix_length": int(row["prefix_length"]),
                "current_activity": row["last_activity"],
                "predicted_suffix": suffix,
                "suffix_length": len(suffix),
                "reached_sink": bool(suffix and suffix[-1]["activity"] in sink_activities),
            })

        return {
            "predictions": predictions[:200],
            "model_info": {
                "method": "iterative_rf_gbr_suffix",
                "inspired_by": "SuTraN (Wuyts, Vanden Broucke, De Weerdt — ICPM 2024)",
                "next_activity_model": "RandomForestClassifier",
                "remaining_time_model": "GradientBoostingRegressor" if time_model else None,
                "max_suffix_length": max_suffix_length,
                "training_samples": int(len(X_train)),
                "num_activities": len(classes),
                "sink_activities": sorted(sink_activities),
            },
        }

    # ── Alarm scoring ────────────────────────────────────────────────────────

    @staticmethod
    def _default_as_of(df: pd.DataFrame) -> datetime | None:
        """Pick a meaningful as-of cutoff for a fully-historical uploaded log.

        With no externally supplied cutoff we still want the alarm to be
        meaningful: it should score cases that are *genuinely in-flight* at the
        chosen moment, not cases that already finished long ago. We take the
        **~0.6 quantile of per-case END timestamps** as the cutoff. By
        construction roughly the latest ~40% of cases (those that finish after
        this point) are still "open" at the cutoff and get scored on their
        truncated, in-progress prefixes, while the earlier ~60% (already
        finished) are excluded. This mirrors a realistic "now" partway through
        the log's lifetime rather than treating completed history as the future.

        Returns ``None`` if timestamps can't be resolved (caller then scores
        nothing, which is the honest answer for an un-timestamped log).
        """
        if TIMESTAMP_COL not in df.columns or df.empty:
            return None
        try:
            case_ends = df.groupby(CASE_COL)[TIMESTAMP_COL].max()
            if case_ends.empty:
                return None
            cutoff = case_ends.quantile(0.6)
            return pd.Timestamp(cutoff).to_pydatetime()
        except Exception as e:  # noqa: BLE001
            logger.warning("alarm scoring: could not derive default as_of: %s", e)
            return None

    def _open_case_prefixes(
        self, df: pd.DataFrame, as_of: datetime
    ) -> pd.DataFrame:
        """Return the event rows of cases that are OPEN at ``as_of``, truncated
        to the events that had occurred by then.

        A case is OPEN at the cutoff iff its first event timestamp ``<= as_of``
        and its last event timestamp ``> as_of`` (i.e. it had started but not
        yet finished). For each open case we keep only the events with
        ``timestamp <= as_of`` — the genuine in-progress trajectory, which is
        also closer to out-of-sample because the case's later (future) events
        never entered the truncated prefix.
        """
        if TIMESTAMP_COL not in df.columns:
            return df.iloc[0:0]
        as_of_ts = pd.Timestamp(as_of)
        bounds = df.groupby(CASE_COL)[TIMESTAMP_COL].agg(["min", "max"])
        open_cases = bounds.index[(bounds["min"] <= as_of_ts) & (bounds["max"] > as_of_ts)]
        if len(open_cases) == 0:
            return df.iloc[0:0]
        truncated = df[
            df[CASE_COL].isin(open_cases) & (df[TIMESTAMP_COL] <= as_of_ts)
        ]
        return truncated

    def score_cases_for_alarm(
        self,
        df: pd.DataFrame,
        sla_threshold: float,
        risk_threshold: float = 0.5,
        event_log_id: Any | None = None,
        as_of: datetime | None = None,
    ) -> list[dict]:
        """Score the cases that are OPEN at an as-of cutoff for SLA-breach risk
        — the interface the automation / alarm layer calls (it must NOT import
        alert_engine here).

        A case is considered OPEN at ``as_of`` iff it had started but not yet
        finished by then (first event ``<= as_of < `` last event). Each open
        case is TRUNCATED to the events that had occurred by ``as_of`` and we
        score *that* in-progress prefix — its real running state at the cutoff,
        which is also closer to out-of-sample. Cases already finished by
        ``as_of`` and cases not yet started are skipped, so a fully-historical
        log no longer flags completed cases as "future risk".

        ``as_of`` defaults to the **~0.6 quantile of per-case end timestamps**
        (see :meth:`_default_as_of`) so a meaningful subset of cases is still
        in-flight at the cutoff on a fully-historical uploaded log. The outcome
        / remaining-time / next-activity models are still trained on the *full*
        historical log (completed cases), then applied to the truncated open
        prefixes.

        For each at-risk case we return:

          * ``breach_probability`` — P(case ends up slow / over SLA), from the
            outcome classifier trained against ``sla_threshold``.
          * ``predicted_remaining_seconds`` — from the remaining-time regressor.
          * ``predicted_finish_over_sla`` — whether elapsed + predicted remaining
            already exceeds the SLA.
          * ``top_next_activities`` — top-3 likely next steps (for routing the
            alarm to the right queue).

        Only cases with ``breach_probability >= risk_threshold`` are returned,
        sorted by descending risk. Models are reused via model_store when
        ``event_log_id`` is supplied.

        The displayed ``breach_probability`` (and ``predicted_remaining_seconds``)
        are out-of-fold (cross-fitted) for prefixes the model trained on, so they
        are honestly out-of-sample and consistent with the reported AUC/MAE. Only
        prefixes outside the out-of-fold map — e.g. a truncated prefix length the
        model never trained on for that case, or a tiny CV-skipped log — fall back
        to the full-data model's output.

        Returns ``[]`` (never raises) when there isn't enough data, no case is
        open at the cutoff, or sklearn is missing — the caller treats an empty
        list as "no alarms".
        """
        # Resolve the as-of cutoff; without one the alarm has no honest notion
        # of "currently in-flight", so we fall back to a derived default.
        if as_of is None:
            as_of = self._default_as_of(df)
        if as_of is None:
            return []

        # Models are trained on the FULL historical log (completed cases),
        # exactly as the other predict_* paths do.
        outcome_payload = self._get_or_train_outcome(df, sla_threshold, event_log_id)
        if (
            outcome_payload is None
            or outcome_payload.get("degenerate")
            or outcome_payload.get("model") is None
        ):
            return []

        outcome_model = outcome_payload["model"]
        outcome_activities = outcome_payload["activities"]
        outcome_oof = outcome_payload.get("oof_breach_probability") or {}

        # Scoring set = open-at-cutoff cases, truncated to their in-progress
        # prefix. The latest prefix per (truncated) case is its current state.
        open_df = self._open_case_prefixes(df, as_of)
        if open_df.empty:
            return []
        feats, _activities_now = _extract_prefix_features(open_df)
        if feats.empty:
            return []
        latest = (
            feats.sort_values("prefix_length")
            .groupby("case_id")
            .tail(1)
            .reset_index(drop=True)
        )
        X_outcome = _assemble_X(latest, outcome_activities)
        try:
            model_breach_prob = outcome_model.predict_proba(X_outcome)[:, 1]
        except Exception as e:  # noqa: BLE001
            logger.warning("alarm scoring: outcome predict_proba failed: %s", e)
            return []
        # Prefer out-of-fold (out-of-sample) probabilities for the truncated
        # prefixes the model trained on; fall back to the full-data model for
        # prefixes outside the out-of-fold map (e.g. CV-skipped tiny logs, or a
        # truncation that doesn't coincide with a trained prefix length).
        breach_prob = [
            float(
                outcome_oof.get(
                    f"{r['case_id']}::{int(r['prefix_length'])}",
                    float(model_breach_prob[i]),
                )
            )
            for i, r in latest.iterrows()
        ]

        # Remaining-time predictions (best-effort — alarms still fire without).
        remaining_by_idx: dict[int, float] = {}
        rt_payload = self._get_or_train_remaining_time(df, event_log_id)
        if rt_payload is not None and rt_payload.get("model") is not None:
            try:
                rt_oof = rt_payload.get("oof_remaining_seconds") or {}
                X_rt = _assemble_X(latest, rt_payload["activities"])
                rt_preds = rt_payload["model"].predict(X_rt)
                for i, r in latest.iterrows():
                    # Prefer the out-of-fold (out-of-sample) estimate.
                    oof_val = rt_oof.get(f"{r['case_id']}::{int(r['prefix_length'])}")
                    raw = oof_val if oof_val is not None else float(rt_preds[i])
                    remaining_by_idx[i] = float(max(0.0, raw))
            except Exception as e:  # noqa: BLE001
                logger.warning("alarm scoring: remaining-time predict failed: %s", e)

        # Next-activity predictions (best-effort).
        next_acts_by_idx: dict[int, list[dict]] = {}
        na_payload = self._get_or_train_next_activity(df, event_log_id)
        if (
            na_payload is not None
            and not na_payload.get("degenerate")
            and na_payload.get("model") is not None
        ):
            try:
                X_na = _assemble_X(latest, na_payload["activities"])
                na_probas = na_payload["model"].predict_proba(X_na)
                na_classes = na_payload["classes"]
                for i in range(len(latest)):
                    top_k = sorted(enumerate(na_probas[i]), key=lambda p: -p[1])[:3]
                    next_acts_by_idx[i] = [
                        {"activity": na_classes[idx], "probability": round(float(p), 3)}
                        for idx, p in top_k
                    ]
            except Exception as e:  # noqa: BLE001
                logger.warning("alarm scoring: next-activity predict failed: %s", e)

        at_risk: list[dict] = []
        for i, row in latest.iterrows():
            prob = float(breach_prob[i])
            if prob < risk_threshold:
                continue
            elapsed = float(row["elapsed_seconds"])
            remaining = remaining_by_idx.get(i)
            predicted_total = elapsed + remaining if remaining is not None else None
            at_risk.append(
                {
                    "case_id": row["case_id"],
                    "prefix_length": int(row["prefix_length"]),
                    "last_activity": row["last_activity"],
                    "elapsed_seconds": round(elapsed, 1),
                    "breach_probability": round(prob, 3),
                    "risk_label": "high" if prob > 0.7 else "medium",
                    "predicted_remaining_seconds": (
                        round(remaining, 1) if remaining is not None else None
                    ),
                    "predicted_total_seconds": (
                        round(predicted_total, 1) if predicted_total is not None else None
                    ),
                    "predicted_finish_over_sla": (
                        bool(predicted_total > sla_threshold)
                        if predicted_total is not None
                        else None
                    ),
                    "top_next_activities": next_acts_by_idx.get(i, []),
                }
            )

        at_risk.sort(key=lambda c: c["breach_probability"], reverse=True)
        return at_risk

    # ── Explainability (SHAP) ────────────────────────────────────────────────

    def explain_case(
        self,
        df: pd.DataFrame,
        case_id: str,
        kind: str = "outcome",
        top_n: int = 8,
        sla_threshold: float | None = None,
        event_log_id: Any | None = None,
    ) -> dict:
        """Explain a single case's prediction with SHAP feature attributions.

        Uses ``shap.TreeExplainer`` on the underlying sklearn tree ensemble
        (RandomForest for ``outcome`` / ``next_activity``, GradientBoosting for
        ``remaining_time``) and returns the top-N signed feature contributions
        for the case's current prefix.

        SHAP is imported LAZILY inside this method so the module never fails to
        import when the dependency is absent (it's a heavy, optional add). If
        shap (or sklearn) isn't installed, or the model/case can't be resolved,
        a ``{"available": False, "reason": ...}`` dict is returned instead of
        raising.
        """
        # Resolve the trained model payload for the requested kind.
        if kind == "remaining_time":
            payload = self._get_or_train_remaining_time(df, event_log_id)
        elif kind == "next_activity":
            payload = self._get_or_train_next_activity(df, event_log_id)
        else:
            kind = "outcome"
            payload = self._get_or_train_outcome(df, sla_threshold, event_log_id)

        if payload is None or payload.get("model") is None:
            return {"available": False, "reason": f"no trained {kind} model (insufficient data?)"}

        model = payload["model"]
        activities = payload["activities"]

        # Locate the case's current (latest) prefix row.
        feats, _ = _extract_prefix_features(df)
        if feats.empty:
            return {"available": False, "reason": "no prefix features for this log"}
        case_rows = feats[feats["case_id"] == str(case_id)]
        if case_rows.empty:
            return {"available": False, "reason": f"case '{case_id}' not found"}
        latest_row = case_rows.sort_values("prefix_length").tail(1).reset_index(drop=True)
        X_case = _assemble_X(latest_row, activities)

        try:
            import shap  # noqa: PLC0415 - lazy, optional heavy dependency
        except Exception as e:  # noqa: BLE001
            return {
                "available": False,
                "reason": f"shap not installed ({e}); install shap>=0.46 to enable explanations",
            }

        # Stable feature names matching _assemble_X's column order.
        numeric_cols = [
            "prefix_length",
            "elapsed_seconds",
            "unique_activities_so_far",
            "rework_count",
            "hour_of_day",
            "day_of_week",
        ]
        feature_names = numeric_cols + [f"last_activity={a}" for a in activities]

        try:
            explainer = shap.TreeExplainer(model)
            shap_values = explainer.shap_values(X_case)
        except Exception as e:  # noqa: BLE001
            return {"available": False, "reason": f"shap explanation failed: {e}"}

        # Normalise shap output to a 1-D vector of per-feature contributions
        # for this single row. Tree explainers return:
        #   * a (1, n_features) array for regressors / binary GBR,
        #   * a list of per-class (1, n_features) arrays for multiclass RF, or
        #   * a (1, n_features, n_classes) ndarray on newer shap.
        try:
            contributions = self._shap_row_for_kind(shap_values, kind, model)
        except Exception as e:  # noqa: BLE001
            return {"available": False, "reason": f"could not interpret shap values: {e}"}

        if contributions is None or len(contributions) != len(feature_names):
            return {"available": False, "reason": "shap value shape did not match feature space"}

        row_vals = X_case[0]
        scored = [
            {
                "feature": feature_names[j],
                "value": round(float(row_vals[j]), 4),
                "contribution": round(float(contributions[j]), 6),
            }
            for j in range(len(feature_names))
        ]
        # Top-N by absolute contribution; keep the sign in the payload.
        scored.sort(key=lambda c: abs(c["contribution"]), reverse=True)

        return {
            "available": True,
            "case_id": str(case_id),
            "kind": kind,
            "prefix_length": int(latest_row.iloc[0]["prefix_length"]),
            "current_activity": str(latest_row.iloc[0]["last_activity"]),
            "top_contributions": scored[:top_n],
            "model_info": payload.get("model_info", {}),
        }

    @staticmethod
    def _shap_row_for_kind(shap_values: Any, kind: str, model: Any):
        """Collapse a TreeExplainer output to the single-row contribution
        vector relevant to the prediction we made (positive class for binary
        classifiers, predicted class for multiclass, the scalar for regressors)."""
        # List form (older shap multiclass): one (n_samples, n_features) per class.
        if isinstance(shap_values, list):
            if kind in ("outcome",):
                # Binary classifier — take the positive-class contributions.
                arr = shap_values[1] if len(shap_values) > 1 else shap_values[0]
                return np.asarray(arr)[0]
            # Multiclass next-activity: pick the predicted class.
            classes = getattr(model, "classes_", None)
            cls_idx = 0
            if classes is not None and len(shap_values) == len(classes):
                # Without the original X we can't re-predict cheaply here; the
                # contributions for the most-probable class were not retained,
                # so fall back to class 0's magnitude profile, which is still a
                # valid per-feature explanation for the model's leaves.
                cls_idx = 0
            return np.asarray(shap_values[cls_idx])[0]

        arr = np.asarray(shap_values)
        if arr.ndim == 1:
            return arr
        if arr.ndim == 2:
            # (n_samples, n_features)
            return arr[0]
        if arr.ndim == 3:
            # (n_samples, n_features, n_classes) — pick positive/last class.
            return arr[0, :, -1]
        return None


predictive_service = PredictiveService()
