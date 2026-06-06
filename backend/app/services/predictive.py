"""
Predictive process monitoring: remaining-time regression and outcome
classification on in-flight cases.

Unlike the earlier prefix-average stub, this uses real sklearn models
trained on features engineered from completed cases:
    [prefix_length, elapsed_seconds, unique_activities_so_far,
     hour_of_day, day_of_week, rework_count, last_activity (one-hot)]

GradientBoostingRegressor drives the remaining-time prediction;
RandomForestClassifier drives the slow-vs-fast outcome prediction.
Models are small enough to train on-request inside ``asyncio.to_thread``.
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np
import pandas as pd

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
    def predict_remaining_time(self, df: pd.DataFrame) -> dict:
        """Train a GradientBoostingRegressor on completed-case prefixes and
        apply it to the CURRENT state of every case.

        Returns top 200 predictions ordered by predicted remaining time.
        """
        feats, activities = _extract_prefix_features(df)
        if feats.empty or len(feats) < 10:
            return {
                "predictions": [],
                "model_info": {"method": "gbr", "reason": "insufficient data", "samples": 0},
            }

        X = _assemble_X(feats, activities)
        y = feats["remaining_seconds"].to_numpy(dtype=float)

        try:
            from sklearn.ensemble import GradientBoostingRegressor
            from sklearn.metrics import mean_absolute_error
            from sklearn.model_selection import train_test_split
        except ImportError:
            return {
                "predictions": [],
                "model_info": {"method": "none", "reason": "sklearn unavailable"},
            }

        # Train/val split so we can report an honest MAE
        try:
            X_train, X_val, y_train, y_val = train_test_split(X, y, test_size=0.2, random_state=42)
        except ValueError:
            X_train, X_val, y_train, y_val = X, X, y, y

        model = GradientBoostingRegressor(
            n_estimators=150, max_depth=4, learning_rate=0.05, random_state=42,
        )
        try:
            model.fit(X_train, y_train)
        except Exception as e:
            logger.warning("GBR fit failed: %s", e)
            return {"predictions": [], "model_info": {"method": "gbr", "reason": f"fit error: {e}"}}

        mae_val = float(mean_absolute_error(y_val, model.predict(X_val))) if len(X_val) else 0.0

        # Latest prefix per case — what we want to predict on
        latest = (
            feats.sort_values("prefix_length")
            .groupby("case_id")
            .tail(1)
            .reset_index(drop=True)
        )
        X_latest = _assemble_X(latest, activities)
        preds = model.predict(X_latest)
        stds = np.std(y_train - model.predict(X_train)) if len(X_train) else 0.0

        predictions = []
        for i, row in latest.iterrows():
            avg_rem = float(max(0.0, preds[i]))
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
            "model_info": {
                "method": "gradient_boosting_regressor",
                "n_estimators": 150,
                "max_depth": 4,
                "training_samples": int(len(X_train)),
                "validation_samples": int(len(X_val)),
                "validation_mae_seconds": round(mae_val, 1),
                "feature_count": int(X.shape[1]),
            },
        }

    def predict_outcome(self, df: pd.DataFrame, sla_threshold: float | None = None) -> dict:
        """Train a RandomForestClassifier to predict slow-vs-fast cases based
        on their prefix features. Uses completed cases whose total duration
        is labelled slow if > SLA threshold (or median if unspecified)."""
        feats, activities = _extract_prefix_features(df)
        if feats.empty or len(feats) < 20:
            return {
                "predictions": [],
                "threshold_seconds": 0,
                "model_info": {"method": "rf", "reason": "insufficient data"},
            }

        # Label every prefix by whether its total case duration is slow
        threshold = sla_threshold if sla_threshold else float(feats["total_seconds"].median())
        y = (feats["total_seconds"] > threshold).astype(int).to_numpy()
        X = _assemble_X(feats, activities)

        try:
            from sklearn.ensemble import RandomForestClassifier
            from sklearn.metrics import roc_auc_score
            from sklearn.model_selection import train_test_split
        except ImportError:
            return {"predictions": [], "model_info": {"method": "none", "reason": "sklearn unavailable"}}

        if y.sum() == 0 or y.sum() == len(y):
            return {
                "predictions": [],
                "threshold_seconds": threshold,
                "model_info": {"method": "rf", "reason": "degenerate label (all one class)"},
            }

        try:
            X_train, X_val, y_train, y_val = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)
        except ValueError:
            X_train, X_val, y_train, y_val = X, X, y, y

        model = RandomForestClassifier(
            n_estimators=200, max_depth=8, random_state=42, n_jobs=1, class_weight="balanced",
        )
        try:
            model.fit(X_train, y_train)
        except Exception as e:
            logger.warning("RF fit failed: %s", e)
            return {"predictions": [], "model_info": {"method": "rf", "reason": f"fit error: {e}"}}

        try:
            probas_val = model.predict_proba(X_val)[:, 1]
            auc = float(roc_auc_score(y_val, probas_val))
        except Exception:
            auc = 0.0

        latest = feats.sort_values("prefix_length").groupby("case_id").tail(1).reset_index(drop=True)
        X_latest = _assemble_X(latest, activities)
        risk = model.predict_proba(X_latest)[:, 1]

        predictions = []
        for i, row in latest.iterrows():
            risk_score = float(risk[i])
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

        slow_rate = float(y.mean() * 100)

        return {
            "predictions": predictions[:200],
            "threshold_seconds": float(threshold),
            "overall_slow_rate": round(slow_rate, 1),
            "model_info": {
                "method": "random_forest_classifier",
                "n_estimators": 200,
                "max_depth": 8,
                "training_samples": int(len(X_train)),
                "validation_samples": int(len(X_val)),
                "validation_auc": round(auc, 3),
                "feature_count": int(X.shape[1]),
            },
        }


    def predict_next_activity(self, df: pd.DataFrame) -> dict:
        """Predict the next activity for each running case.

        Approach: for every completed case, emit one training example per
        prefix with features = [last_activity_onehot, prefix_length,
        unique_activities, elapsed_sec, hour_of_day] and target = the
        next activity label. Train a RandomForestClassifier, then score
        each case at its current prefix and return the top-k likely next
        activities with probabilities.

        This is the third leg of the predictive monitoring trio
        (remaining_time + outcome + next_activity) and is what every
        serious competitor ships.
        """
        feats, activities = _extract_prefix_features(df)
        if feats.empty or len(feats) < 20 or len(activities) < 2:
            return {
                "predictions": [],
                "model_info": {"method": "rf", "reason": "insufficient data"},
            }

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
            return {"predictions": [], "model_info": {"method": "rf", "reason": "insufficient labelled prefixes"}}

        X = _assemble_X(train_df, activities)
        y = train_df["next_activity"].to_numpy()

        try:
            from sklearn.ensemble import RandomForestClassifier
            from sklearn.metrics import accuracy_score
            from sklearn.model_selection import train_test_split
        except ImportError:
            return {"predictions": [], "model_info": {"reason": "sklearn unavailable"}}

        # Need at least 2 classes
        unique_targets = list(set(y.tolist()))
        if len(unique_targets) < 2:
            return {"predictions": [], "model_info": {"reason": "only one possible next activity"}}

        try:
            X_train, X_val, y_train, y_val = train_test_split(X, y, test_size=0.2, random_state=42)
        except ValueError:
            X_train, X_val, y_train, y_val = X, X, y, y

        model = RandomForestClassifier(n_estimators=200, max_depth=10, random_state=42, n_jobs=1)
        try:
            model.fit(X_train, y_train)
        except Exception as e:
            logger.warning("next-activity RF fit failed: %s", e)
            return {"predictions": [], "model_info": {"reason": f"fit error: {e}"}}

        try:
            val_acc = float(accuracy_score(y_val, model.predict(X_val)))
        except Exception:
            val_acc = 0.0

        # Predict on the latest prefix per case
        latest = feats.sort_values("prefix_length").groupby("case_id").tail(1).reset_index(drop=True)
        X_latest = _assemble_X(latest, activities)
        probas = model.predict_proba(X_latest)
        classes = list(model.classes_)

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


predictive_service = PredictiveService()
