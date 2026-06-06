"""Narrative insight generation across the full process log."""

import logging
from typing import Optional

import numpy as np
import pandas as pd

from app.services.ingestion import (
    CASE_COL,
    ACTIVITY_COL,
    TIMESTAMP_COL,
    RESOURCE_COL,
    COST_COL,
)
from app.services.rust_accel import (
    discover_performance_dfg as _rs_perf_dfg,
    compute_efg as _rs_efg,
    compute_temporal_profile as _rs_temporal,
    compute_sna as _rs_sna,
    compute_case_overlap as _rs_case_overlap,
    compute_rework as _rs_rework,
    compute_edge_stats as _rs_edge_stats,
)

logger = logging.getLogger(__name__)

# ── Automation dollar-ROI defaults ───────────────────────────────────────────
# Default fully-loaded FTE hourly rate used to convert hours_saved → dollar_roi
# in the automation insight.  Callers can override this by passing
# fte_hourly_rate to generate_insights().  $45/hr matches the US BLS median
# for administrative/clerical workers — a conservative anchor that under-sells
# rather than over-sells automation value.
DEFAULT_FTE_HOURLY_RATE: float = 45.0


def _fmt_dur(seconds):
    if seconds < 60:
        return f"{seconds:.0f}s"
    if seconds < 3600:
        return f"{seconds/60:.1f}m"
    if seconds < 86400:
        return f"{seconds/3600:.1f}h"
    return f"{seconds/86400:.1f}d"


def generate_insights(engine, df: pd.DataFrame, fte_hourly_rate: float | None = None) -> dict:
    """
    Run multiple analyses on the DataFrame and generate plain-language insights.

    Calls existing analysis methods and synthesises the results into actionable
    Insight dicts, sorted by severity (critical → warning → info).

    Args:
        engine: The mining engine instance.
        df: The event log DataFrame.
        fte_hourly_rate: Fully-loaded FTE cost per hour used to convert hours
            saved → dollar ROI in the automation insight.  If ``None``, falls
            back to ``DEFAULT_FTE_HOURLY_RATE`` ($45/hr).

    Returns:
        dict with keys: insights (list of insight dicts), summary (str)
    """
    _fte_rate = fte_hourly_rate if fte_hourly_rate is not None else DEFAULT_FTE_HOURLY_RATE
    insights: list[dict] = []

    # ── 1. Basic stats (used by many blocks below) ───────────────────────
    total_cases = int(df[CASE_COL].nunique())
    total_events = len(df)
    total_activities = int(df[ACTIVITY_COL].nunique())

    # Case durations — computed early so downstream blocks can reference it
    try:
        _cd_grp = df.groupby(CASE_COL)[TIMESTAMP_COL]
        case_durations = (_cd_grp.max() - _cd_grp.min()).dt.total_seconds()
        avg_case_duration = float(case_durations.mean()) if len(case_durations) > 0 else 0.0
    except Exception:
        case_durations = pd.Series(dtype=float)
        avg_case_duration = 0.0

    # Track results from early analyses so later blocks can cross-reference
    bottleneck_result: dict | None = None
    rework_result: dict | None = None
    overall_rework_rate = 0.0

    # ── 2. Bottleneck insights ───────────────────────────────────────────
    try:
        bottleneck_result = engine.run_bottleneck_analysis(df)
        bottlenecks = bottleneck_result.get('bottlenecks', [])
        critical = [b for b in bottlenecks if b.get('is_bottleneck')]
        if critical:
            worst = max(critical, key=lambda b: b.get('avg_duration', 0))
            avg_dur = worst['avg_duration']
            dur_str = _fmt_dur(avg_dur)
            median_all = sorted([b['avg_duration'] for b in bottlenecks])
            median_val = median_all[len(median_all) // 2] if median_all else avg_dur
            pct_above = ((avg_dur - median_val) / median_val * 100) if median_val > 0 else 0
            half_saved = avg_dur * 0.5

            insights.append({
                'category': 'bottleneck',
                'severity': 'critical',
                'title': f'"{worst["activity"]}" is your biggest bottleneck',
                'description': f'This activity takes {dur_str} on average, which is {pct_above:.0f}% longer than the median activity duration.',
                'metric_value': avg_dur,
                'recommendation': f'Focus optimization efforts on "{worst["activity"]}". Consider automating parts of this step, adding resources, or redesigning the workflow to reduce time spent here.',
                'related_activities': [worst['activity']],
                'impact_estimate': f'Reducing duration by 50% would save ~{_fmt_dur(half_saved)} per occurrence.',
            })

        if len(critical) > 1:
            insights.append({
                'category': 'bottleneck',
                'severity': 'warning',
                'title': f'{len(critical)} activities flagged as bottlenecks',
                'description': f'Activities {", ".join(b["activity"] for b in critical[:3])} are all taking significantly longer than average.',
                'metric_value': len(critical),
                'recommendation': 'Prioritize the slowest bottleneck first, then work through the list.',
                'related_activities': [b['activity'] for b in critical[:5]],
            })
    except Exception:
        pass

    # ── 3. Waiting time / handoff bottleneck ─────────────────────────────
    try:
        if bottleneck_result and avg_case_duration > 0:
            waiting_times = bottleneck_result.get('waiting_times', [])
            if waiting_times:
                top_wait = waiting_times[0]  # already sorted desc by avg_waiting
                avg_wait = top_wait['avg_waiting']
                wait_pct = (avg_wait / avg_case_duration * 100) if avg_case_duration > 0 else 0
                if wait_pct > 25:
                    sev = 'critical' if wait_pct > 50 else 'warning'
                    half_wait = avg_wait / 2
                    insights.append({
                        'category': 'waiting_time',
                        'severity': sev,
                        'title': f'Cases wait longest between "{top_wait["source"]}" and "{top_wait["target"]}"',
                        'description': f'The handoff between these steps averages {_fmt_dur(avg_wait)} — {wait_pct:.0f}% of total case duration. The worst case waited {_fmt_dur(top_wait["max_waiting"])}.',
                        'metric_value': avg_wait,
                        'recommendation': f'This idle time is not processing — it is waiting. Investigate whether it is queue buildup, email-based handoffs, or a capacity issue on "{top_wait["target"]}".',
                        'related_activities': [top_wait['source'], top_wait['target']],
                        'impact_estimate': f'Cutting this waiting time by half would reduce avg case duration by ~{_fmt_dur(half_wait)}.',
                    })
    except Exception:
        pass

    # ── 4. Variant insights ──────────────────────────────────────────────
    variant_result: dict | None = None
    try:
        variant_result = engine.run_variant_analysis(df)
        variants = variant_result.get('variants', [])
        total_variants = variant_result.get('total_variants', len(variants))
        if variants:
            top_coverage = variants[0].get('percentage', 0)
            if top_coverage < 50:
                insights.append({
                    'category': 'variant',
                    'severity': 'warning',
                    'title': 'Highly variable process',
                    'description': f'The most common execution path covers only {top_coverage:.1f}% of cases. There are {total_variants} unique variants.',
                    'metric_value': top_coverage,
                    'recommendation': 'High variability may indicate ad-hoc workarounds or lack of standardization. Review less common variants to see if they can be eliminated or standardized.',
                })
            elif total_variants == 1:
                insights.append({
                    'category': 'variant',
                    'severity': 'info',
                    'title': 'Perfectly standardized process',
                    'description': 'All cases follow the exact same execution path.',
                    'metric_value': 100.0,
                    'recommendation': 'Great consistency! Monitor for future deviations.',
                })

            if len(variants) >= 2:
                fast = variants[0].get('avg_duration')
                slow = max((v.get('avg_duration') or 0 for v in variants), default=0)
                if fast and slow and fast > 0 and slow / fast > 3:
                    insights.append({
                        'category': 'duration',
                        'severity': 'warning',
                        'title': 'Large duration spread between variants',
                        'description': f'The slowest variant takes {_fmt_dur(slow)}, while the fastest takes {_fmt_dur(fast)} — a {slow/fast:.1f}x difference.',
                        'metric_value': slow / fast,
                        'recommendation': 'Investigate what causes slower variants. They may involve additional approval steps, rework, or waiting times.',
                    })
    except Exception:
        pass

    # ── 5. Happy path narrative ──────────────────────────────────────────
    try:
        if variant_result:
            variants = variant_result.get('variants', [])
            if len(variants) >= 3:
                happy = variants[0]
                happy_dur = happy.get('avg_duration') or 0
                happy_pct = happy.get('percentage', 0)
                happy_acts = happy.get('activities', [])
                if happy_dur > 0 and happy_pct >= 20:
                    # Weighted avg duration of non-happy variants
                    other_total_cases = 0
                    other_weighted_dur = 0.0
                    for v in variants[1:]:
                        vc = v.get('case_count', 0)
                        vd = v.get('avg_duration') or 0
                        other_total_cases += vc
                        other_weighted_dur += vc * vd
                    other_avg_dur = (other_weighted_dur / other_total_cases) if other_total_cases > 0 else 0
                    extra_time = other_avg_dur - happy_dur
                    if extra_time > 0 and other_total_cases > 0:
                        deviating_pct = 100 - happy_pct
                        # If 50% of deviating cases followed the happy path
                        saved_per_case = (extra_time * 0.5 * (deviating_pct / 100))
                        path_str = ' → '.join(happy_acts[:6])
                        if len(happy_acts) > 6:
                            path_str += ' → …'
                        insights.append({
                            'category': 'variant',
                            'severity': 'info',
                            'title': f'Happy path completes in {_fmt_dur(happy_dur)}; detours add {_fmt_dur(extra_time)} on average',
                            'description': f'The most common path ({path_str}) covers {happy_pct:.0f}% of cases and completes in {_fmt_dur(happy_dur)}. The remaining {deviating_pct:.0f}% follow {len(variants) - 1} other variants averaging {_fmt_dur(other_avg_dur)}.',
                            'metric_value': extra_time,
                            'recommendation': f'Investigate what causes cases to deviate from the happy path. Standardizing more cases to the main path could significantly reduce cycle time.',
                            'related_activities': happy_acts[:5],
                            'impact_estimate': f'If 50% of deviating cases followed the happy path, avg case duration would drop by ~{_fmt_dur(saved_per_case)}.',
                        })
    except Exception:
        pass

    # ── 6. Rework insights ───────────────────────────────────────────────
    try:
        rework_result = engine.get_rework(df)
        overall_rework_rate = rework_result.get('overall_rework_rate', 0)
        if overall_rework_rate > 20:
            rework_acts = rework_result.get('activities', [])
            worst_rework = max(rework_acts, key=lambda a: a.get('rework_rate', 0)) if rework_acts else None
            insights.append({
                'category': 'rework',
                'severity': 'critical' if overall_rework_rate > 40 else 'warning',
                'title': f'{overall_rework_rate:.0f}% of cases involve rework',
                'description': (
                    f'{rework_result.get("cases_with_rework", 0)} out of {total_cases} cases have at least one repeated activity.'
                    + (f' The most reworked activity is "{worst_rework["activity"]}" ({worst_rework["rework_rate"]:.0f}% rework rate).' if worst_rework else '')
                ),
                'metric_value': overall_rework_rate,
                'recommendation': 'Rework often indicates errors, incomplete work, or unclear requirements. Investigate the root cause of repeated activities and consider adding quality checks earlier in the process.',
                'related_activities': [a['activity'] for a in rework_acts[:3]] if rework_acts else None,
            })

        self_loops = rework_result.get('self_loops', [])
        if self_loops:
            insights.append({
                'category': 'rework',
                'severity': 'info',
                'title': f'{len(self_loops)} self-loop{"s" if len(self_loops) != 1 else ""} detected',
                'description': f'Activities that immediately repeat: {", ".join(s["activity"] for s in self_loops[:3])}.',
                'metric_value': len(self_loops),
                'recommendation': 'Self-loops may indicate retry behavior, data entry corrections, or system issues.',
                'related_activities': [s['activity'] for s in self_loops[:5]],
            })
    except Exception:
        pass

    # ── 7. Conformance insights ──────────────────────────────────────────
    try:
        conf_result = engine.run_conformance(df)
        fitness = conf_result.get('fitness', 1.0)
        if fitness < 0.8:
            conformant = conf_result.get('conformant_cases', 0)
            total = conf_result.get('total_cases', total_cases)
            dev_pct = ((total - conformant) / total * 100) if total > 0 else 0
            insights.append({
                'category': 'conformance',
                'severity': 'critical' if fitness < 0.6 else 'warning',
                'title': f'Low process conformance ({fitness*100:.0f}%)',
                'description': f'{dev_pct:.0f}% of cases deviate from the expected process model. {len(conf_result.get("deviations", []))} individual deviations detected.',
                'metric_value': fitness,
                'recommendation': 'Review the most common deviations. They may indicate training gaps, system workarounds, or legitimate process exceptions that should be modeled.',
            })
    except Exception:
        pass

    # ── 8. Resource concentration ────────────────────────────────────────
    try:
        if RESOURCE_COL in df.columns:
            resource_activity = df.groupby([ACTIVITY_COL, RESOURCE_COL]).size().reset_index(name='count')
            activity_totals = df.groupby(ACTIVITY_COL).size().reset_index(name='total')
            merged = resource_activity.merge(activity_totals, on=ACTIVITY_COL)
            merged['pct'] = merged['count'] / merged['total'] * 100
            concentrated = merged[merged['pct'] > 60].sort_values('pct', ascending=False)
            if len(concentrated) > 0:
                top = concentrated.iloc[0]
                insights.append({
                    'category': 'resource',
                    'severity': 'warning',
                    'title': f'Resource concentration on "{top[ACTIVITY_COL]}"',
                    'description': f'Resource "{top[RESOURCE_COL]}" handles {top["pct"]:.0f}% of all "{top[ACTIVITY_COL]}" events. This creates a single point of failure.',
                    'metric_value': top['pct'],
                    'recommendation': f'Cross-train additional resources on "{top[ACTIVITY_COL]}" to reduce dependency and improve resilience.',
                    'related_activities': [top[ACTIVITY_COL]],
                })
    except Exception:
        pass

    # ── 9. Automation opportunity ────────────────────────────────────────
    try:
        if bottleneck_result:
            bottlenecks = bottleneck_result.get('bottlenecks', [])
            critical_names = {b['activity'] for b in bottlenecks if b.get('is_bottleneck')}
            avg_freq = total_events / max(total_activities, 1)
            candidates = [
                b for b in bottlenecks
                if b.get('avg_duration', 999) < 300
                and b.get('frequency', 0) > avg_freq
                and b['activity'] not in critical_names
            ]
            if candidates:
                best = max(candidates, key=lambda b: b.get('frequency', 0))
                freq = best['frequency']
                dur = best['avg_duration']
                hours_saved = (freq * dur) / 3600
                dollar_roi = hours_saved * _fte_rate
                insights.append({
                    'category': 'automation',
                    'severity': 'info',
                    'title': f'"{best["activity"]}" is a strong automation candidate',
                    'description': f'This activity occurs {freq:,} times with an average duration of {_fmt_dur(dur)} — high-frequency, low-complexity, and consumes significant resource time.',
                    'metric_value': hours_saved,
                    'dollar_roi': round(dollar_roi, 2),
                    'fte_hourly_rate_used': _fte_rate,
                    'recommendation': f'Activities like this are well-suited for RPA or workflow automation. Automating "{best["activity"]}" at current frequency would free up substantial capacity.',
                    'related_activities': [best['activity']],
                    'impact_estimate': (
                        f'Estimated {hours_saved:.1f} hours saved per period ({freq:,} occurrences × {_fmt_dur(dur)}) '
                        f'≈ ${dollar_roi:,.0f} at ${_fte_rate:.0f}/hr FTE rate.'
                    ),
                })
    except Exception:
        pass

    # ── 10. Batch processing insight ─────────────────────────────────────
    try:
        batch_result = engine.get_batches(df)
        batches = batch_result.get('batches', [])
        if batches:
            biggest = max(batches, key=lambda b: b.get('num_cases', 0))
            sev = 'warning' if biggest.get('num_cases', 0) > 20 else 'info'
            insights.append({
                'category': 'batch',
                'severity': sev,
                'title': f'Batch processing detected on "{biggest["activity"]}"',
                'description': f'Resource "{biggest.get("resource", "unknown")}" processes "{biggest["activity"]}" in {biggest.get("batch_type", "simultaneous")} batches, with up to {biggest["num_cases"]} cases at once.',
                'metric_value': biggest['num_cases'],
                'recommendation': 'Batching can hide individual case delays. Consider whether batch sizes are intentional or caused by queue buildup.',
                'related_activities': [biggest['activity']],
            })
    except Exception:
        pass

    # ── 11. Concurrent case load ─────────────────────────────────────────
    try:
        overlap_result = engine.get_case_overlap(df)
        max_overlap = overlap_result.get('max_overlap', 0)
        avg_overlap = overlap_result.get('avg_overlap', 0)
        if avg_overlap > 0 and max_overlap > 5 * avg_overlap:
            ratio = max_overlap / avg_overlap
            insights.append({
                'category': 'workload',
                'severity': 'warning',
                'title': f'Peak concurrent load reaches {ratio:.1f}x the average',
                'description': f'The process typically handles {avg_overlap:.0f} cases simultaneously, but peaks at {max_overlap} concurrent cases. This workload spike likely contributes to bottlenecks and waiting times.',
                'metric_value': max_overlap,
                'recommendation': 'Investigate whether these spikes are predictable (e.g., month-end). If so, pre-emptive resource allocation or case prioritization could smooth throughput.',
            })
    except Exception:
        pass

    # ── 12. Root cause attribute correlation ─────────────────────────────
    try:
        extra_cols = [c for c in df.columns if c not in {CASE_COL, ACTIVITY_COL, TIMESTAMP_COL, RESOURCE_COL}]
        if extra_cols:
            rc_result = engine.run_root_cause_analysis(df)
            factors = rc_result.get('factors', [])
            for factor in factors[:1]:  # top factor only
                dur_affected = factor.get('avg_duration_affected', 0)
                dur_normal = factor.get('avg_duration_normal', 0)
                case_count = factor.get('case_count', 0)
                if dur_normal > 0 and case_count >= 10:
                    ratio = dur_affected / dur_normal
                    if ratio > 1.5:
                        diff = dur_affected - dur_normal
                        insights.append({
                            'category': 'root_cause',
                            'severity': 'critical' if ratio > 2 else 'warning',
                            'title': f'Cases with "{factor["attribute"]} = {factor["value"]}" take {ratio:.1f}x longer',
                            'description': f'The {case_count} cases where {factor["attribute"]} is "{factor["value"]}" average {_fmt_dur(dur_affected)}, versus {_fmt_dur(dur_normal)} for all other cases — a difference of {_fmt_dur(diff)}.',
                            'metric_value': ratio,
                            'recommendation': f'This attribute strongly predicts slow cases. Investigate what is different about "{factor["value"]}" — staffing, data quality, or process differences.',
                            'impact_estimate': f'~{_fmt_dur(diff)} extra per case, affecting {case_count} cases.',
                        })
    except Exception:
        pass

    # ── 13. Temporal deviation ───────────────────────────────────────────
    try:
        tp_result = engine.get_temporal_profile(df)
        profiles = tp_result.get('profiles', [])
        deviations = tp_result.get('deviations', [])

        # Find highest coefficient of variation
        if profiles:
            best_cv = None
            for p in profiles:
                mean = p.get('mean', 0)
                stdev = p.get('stdev', 0)
                if mean > 0:
                    cv = stdev / mean
                    if best_cv is None or cv > best_cv[0]:
                        best_cv = (cv, p)
            if best_cv and best_cv[0] > 1.0:
                cv_val, p = best_cv
                insights.append({
                    'category': 'timing_anomaly',
                    'severity': 'warning',
                    'title': f'Transition from "{p["source"]}" to "{p["target"]}" is highly unpredictable',
                    'description': f'This step averages {_fmt_dur(p["mean"])} but has a standard deviation of {_fmt_dur(p["stdev"])} (CV = {cv_val:.1f}). Some cases fly through in minutes; others take days.',
                    'metric_value': cv_val,
                    'recommendation': f'High variance suggests no consistent process for handling this step. Investigate whether routing rules, resource availability, or case complexity drive the spread.',
                    'related_activities': [p['source'], p['target']],
                })

        # Deviation count
        if deviations:
            dev_count = len(deviations)
            insights.append({
                'category': 'timing_anomaly',
                'severity': 'info' if dev_count < 50 else 'warning',
                'title': f'{dev_count} case{"s have" if dev_count != 1 else " has"} timing anomalies',
                'description': f'{dev_count} case{"s show" if dev_count != 1 else " shows"} at least one activity transition that took more than 2 standard deviations from the expected time — either unusually fast or unusually slow.',
                'metric_value': dev_count,
                'recommendation': 'Review these cases for missed steps, data entry delays, or exceptional handling that inflated timestamps.',
            })
    except Exception:
        pass

    # ── 14. Resource cross-perspective: rework by resource ────────────────
    try:
        if RESOURCE_COL in df.columns and rework_result and overall_rework_rate > 0:
            cases_with_rework_set = set()
            for act in rework_result.get('activities', []):
                for cid in act.get('case_ids', []):
                    cases_with_rework_set.add(cid)
            if not cases_with_rework_set:
                # Derive from df: cases where any activity appears >1 time
                case_act_counts = df.groupby([CASE_COL, ACTIVITY_COL]).size().reset_index(name='cnt')
                cases_with_rework_set = set(case_act_counts[case_act_counts['cnt'] > 1][CASE_COL].unique())

            if cases_with_rework_set:
                # Primary resource per case = most frequent resource (mode) in that case.
                # Vectorized: count (case, resource) pairs, sort by count desc then resource
                # asc (alphabetic tie-break mirrors pandas mode().iloc[0] behaviour).
                _res_counts = (
                    df.groupby([CASE_COL, RESOURCE_COL], sort=False)
                    .size()
                    .rename('_cnt')
                    .reset_index()
                    .sort_values([CASE_COL, '_cnt', RESOURCE_COL], ascending=[True, False, True])
                )
                case_resource = (
                    _res_counts
                    .drop_duplicates(subset=CASE_COL, keep='first')
                    .set_index(CASE_COL)[RESOURCE_COL]
                )
                resource_cases = case_resource.groupby(case_resource).apply(lambda g: g.index.tolist())
                worst_resource = None
                worst_ratio = 0
                for resource, case_ids in resource_cases.items():
                    if len(case_ids) < 10:
                        continue
                    rework_count = sum(1 for cid in case_ids if cid in cases_with_rework_set)
                    rate = (rework_count / len(case_ids)) * 100
                    ratio = rate / overall_rework_rate if overall_rework_rate > 0 else 0
                    if ratio > worst_ratio:
                        worst_ratio = ratio
                        worst_resource = (resource, len(case_ids), rate, rework_count)

                if worst_resource and worst_ratio > 2:
                    res_name, res_cases, res_rate, res_rework = worst_resource
                    excess = res_rework - int(res_cases * overall_rework_rate / 100)
                    insights.append({
                        'category': 'resource',
                        'severity': 'warning',
                        'title': f'"{res_name}" has {worst_ratio:.1f}x the average rework rate',
                        'description': f'"{res_name}" handles {res_cases} cases with a {res_rate:.0f}% rework rate, compared to the process average of {overall_rework_rate:.0f}%. This may indicate a training issue or systematically harder case assignment.',
                        'metric_value': res_rate,
                        'recommendation': f'Investigate whether "{res_name}" handles a specific type of complex case, or whether targeted training would reduce rework.',
                        'impact_estimate': f'If this resource matched the average rate, ~{excess} rework incidents per period would be eliminated.',
                    })
    except Exception:
        pass

    # ── 15. Cost insights (conditional on COST_COL) ──────────────────────
    try:
        if COST_COL in df.columns:
            total_cost = df[COST_COL].sum()
            if total_cost > 0 and rework_result:
                # Rework cost: derive cases with rework
                case_act_counts = df.groupby([CASE_COL, ACTIVITY_COL]).size().reset_index(name='cnt')
                rework_case_ids = set(case_act_counts[case_act_counts['cnt'] > 1][CASE_COL].unique())
                case_costs = df.groupby(CASE_COL)[COST_COL].sum()
                rework_cost = float(case_costs[case_costs.index.isin(rework_case_ids)].sum())
                rework_pct = (rework_cost / total_cost * 100) if total_cost > 0 else 0
                if rework_pct > 10:
                    avg_cost_rework = float(case_costs[case_costs.index.isin(rework_case_ids)].mean())
                    avg_cost_normal = float(case_costs[~case_costs.index.isin(rework_case_ids)].mean())
                    insights.append({
                        'category': 'cost',
                        'severity': 'warning',
                        'title': f'Rework accounts for {rework_pct:.0f}% of total cost',
                        'description': f'Cases with rework have an average cost of {avg_cost_rework:,.0f}, versus {avg_cost_normal:,.0f} for cases without rework — a {((avg_cost_rework / max(avg_cost_normal, 1)) - 1) * 100:.0f}% premium.',
                        'metric_value': rework_pct,
                        'recommendation': 'Reducing rework would directly lower costs. Target the activities with the highest rework rates for quality improvements.',
                        'impact_estimate': f'Eliminating rework could save up to {rework_cost:,.0f} in cost.',
                    })
    except Exception:
        pass

    # ── 16. Case duration insight (informational) ────────────────────────
    try:
        if avg_case_duration > 0 and len(case_durations) > 0:
            insights.append({
                'category': 'performance',
                'severity': 'info',
                'title': f'Average case takes {_fmt_dur(avg_case_duration)}',
                'description': f'Cases range from {_fmt_dur(case_durations.min())} to {_fmt_dur(case_durations.max())}. Median is {_fmt_dur(case_durations.median())}.',
                'metric_value': avg_case_duration,
                'recommendation': None,
            })
    except Exception:
        pass

    # ── 17. Long tail of slow cases (P90/P50 ratio) ──────────────────────
    # A few extreme outlier cases can distort every downstream metric.
    # Surface them separately so users can investigate stuck / abandoned
    # cases instead of writing off the whole process as "slow".
    try:
        if len(case_durations) >= 20:
            p50 = float(case_durations.quantile(0.5))
            p90 = float(case_durations.quantile(0.9))
            p99 = float(case_durations.quantile(0.99))
            if p50 > 0 and (p90 / p50) > 4:
                pct_over_p90 = int((case_durations > p90).sum())
                insights.append({
                    'category': 'duration',
                    'severity': 'warning' if p90 / p50 > 8 else 'info',
                    'title': f'Long tail: slowest 10% of cases take {p90/p50:.1f}x the median',
                    'description': (
                        f'Median case finishes in {_fmt_dur(p50)}; the 90th percentile is {_fmt_dur(p90)} '
                        f'and the 99th percentile reaches {_fmt_dur(p99)}. {pct_over_p90} cases exceed the P90 threshold.'
                    ),
                    'metric_value': p90 / p50,
                    'recommendation': 'Investigate the slowest cases individually — they are often stuck on a single step, waiting on external approval, or abandoned. Eliminating the tail is usually cheaper than speeding up the median.',
                })
    except Exception:
        pass

    # ── 18. Off-hours / weekend work ─────────────────────────────────────
    # Operational work happening outside normal business hours usually
    # means on-call, emergency escalation, or batch scripts running at
    # night. Either way, it's worth knowing how much of the process
    # actually runs off-hours.
    try:
        ts = pd.to_datetime(df[TIMESTAMP_COL], errors='coerce').dropna()
        if len(ts) > 50:
            if getattr(ts.dt, 'tz', None) is not None:
                ts = ts.dt.tz_convert('UTC').dt.tz_localize(None)
            hour = ts.dt.hour
            dow = ts.dt.dayofweek  # 0 = Mon
            off_hours = ((hour < 7) | (hour >= 19)).sum()
            weekend = (dow >= 5).sum()
            total = len(ts)
            off_pct = (off_hours / total) * 100
            wk_pct = (weekend / total) * 100
            if off_pct >= 20:
                insights.append({
                    'category': 'workload',
                    'severity': 'warning' if off_pct >= 40 else 'info',
                    'title': f'{off_pct:.0f}% of events happen outside business hours',
                    'description': (
                        f'{int(off_hours):,} of {total:,} events land between 7pm and 7am. '
                        f'{wk_pct:.0f}% land on a weekend.'
                    ),
                    'metric_value': off_pct,
                    'recommendation': 'Off-hours activity usually means on-call work, batch jobs, or SLA escalations. Decide whether this is an automation pattern to keep or an overtime pattern to eliminate.',
                })
    except Exception:
        pass

    # ── 19. Unusual start / end activities ───────────────────────────────
    # Healthy processes almost always start with one of a small set of
    # entry activities. A case that starts mid-process often means
    # missing upstream events or an incomplete extraction.
    try:
        per_case = df.sort_values(TIMESTAMP_COL).groupby(CASE_COL, sort=False)
        starts = per_case[ACTIVITY_COL].first().value_counts()
        ends = per_case[ACTIVITY_COL].last().value_counts()
        if total_cases >= 20 and len(starts) > 0:
            top_start = starts.iloc[0]
            top_start_pct = (top_start / total_cases) * 100
            distinct_starts = int((starts > 0).sum())
            if distinct_starts > 3 and top_start_pct < 60:
                insights.append({
                    'category': 'structure',
                    'severity': 'warning',
                    'title': f'{distinct_starts} different activities kick off cases',
                    'description': (
                        f'Only {top_start_pct:.0f}% of cases start with the most common entry point '
                        f'("{starts.idxmax()}"). The remaining cases begin with {distinct_starts - 1} other activities.'
                    ),
                    'metric_value': float(distinct_starts),
                    'recommendation': 'Multiple start points usually mean (a) the log is incomplete (missing initial events) or (b) the process has several legitimate triggers. If the first, fix extraction; if the second, document each entry path.',
                })
        if total_cases >= 20 and len(ends) > 0:
            top_end_pct = (ends.iloc[0] / total_cases) * 100
            if top_end_pct < 50 and int((ends > 0).sum()) > 5:
                insights.append({
                    'category': 'structure',
                    'severity': 'warning',
                    'title': f'Cases end in {int((ends > 0).sum())} different activities',
                    'description': (
                        f'The most common end state ("{ends.idxmax()}") covers only {top_end_pct:.0f}% of cases. '
                        'Many cases may be abandoning, escalating, or terminating early.'
                    ),
                    'metric_value': float(int((ends > 0).sum())),
                    'recommendation': 'Look at the less common end activities. They often flag abandonments, returns, or unhappy-path exits that deserve their own follow-up.',
                })
    except Exception:
        pass

    # ── 20. Variant Pareto concentration ─────────────────────────────────
    # Standardised processes usually obey a ~Pareto distribution: a
    # handful of variants cover most cases. We've already covered the
    # top-1 coverage case above; this block looks at the broader shape.
    try:
        if variant_result:
            variants = variant_result.get('variants', [])
            tv = variant_result.get('total_variants', len(variants))
            if tv >= 5 and total_cases > 0:
                # How many variants to cover 80% of cases?
                covered = 0
                needed = 0
                target = total_cases * 0.8
                for v in variants:
                    covered += v.get('case_count', 0)
                    needed += 1
                    if covered >= target:
                        break
                concentration = needed / tv
                if concentration > 0.6:
                    insights.append({
                        'category': 'variant',
                        'severity': 'warning',
                        'title': f'No dominant path — {needed} variants needed to cover 80% of cases',
                        'description': (
                            f'Out of {tv} variants, {needed} are required to capture 80% of cases. '
                            'A well-standardised process usually needs 20% of variants to cover 80% of cases.'
                        ),
                        'metric_value': concentration,
                        'recommendation': 'A long, flat variant distribution signals ad-hoc process execution. Look for the common subsequences that appear across many variants and turn them into a documented happy path.',
                    })
    except Exception:
        pass

    # ── 21. Four-eyes principle compliance ───────────────────────────────
    # Generic four-eyes check: does any resource ever both request and
    # approve within the same case? We scan activity names for common
    # request/approve pairs so this works without explicit configuration.
    # If there's no `org:resource` column we skip entirely.
    try:
        if RESOURCE_COL in df.columns:
            acts_lower = {str(a).lower(): str(a) for a in df[ACTIVITY_COL].dropna().unique()}
            req_acts = [orig for low, orig in acts_lower.items() if 'request' in low or 'submit' in low or 'create' in low]
            app_acts = [orig for low, orig in acts_lower.items() if 'approve' in low or 'sign' in low or 'authorize' in low]
            if req_acts and app_acts:
                res = engine.check_four_eyes(df, req_acts[0], app_acts[0])
                violations = res.get('violating_cases', 0)
                total = res.get('total_cases', total_cases) or 1
                viol_pct = (violations / total) * 100
                if violations > 0:
                    insights.append({
                        'category': 'compliance',
                        'severity': 'critical' if viol_pct > 5 else 'warning',
                        'title': f'Four-eyes violations: {violations} case{"s" if violations != 1 else ""}',
                        'description': (
                            f'{violations} of {total} cases ({viol_pct:.1f}%) have the same resource performing both '
                            f'"{req_acts[0]}" and "{app_acts[0]}" — a segregation-of-duties break.'
                        ),
                        'metric_value': float(violations),
                        'recommendation': f'Enforce role separation in your workflow so the person requesting "{req_acts[0]}" cannot approve it. Each violation is an audit finding waiting to happen.',
                        'related_activities': [req_acts[0], app_acts[0]],
                    })
    except Exception:
        pass

    # ── 22. Concept drift (split-half comparison) ────────────────────────
    # Processes change over time — new variants appear, old ones die,
    # timing shifts. Split the log in half chronologically and compare
    # first-half vs second-half avg case duration. If the delta is
    # large it's worth flagging because most downstream analysis treats
    # the log as stationary.
    try:
        if len(case_durations) >= 40:
            case_starts = df.groupby(CASE_COL)[TIMESTAMP_COL].min().sort_values()
            midpoint = case_starts.iloc[len(case_starts) // 2]
            earlier = case_starts[case_starts <= midpoint].index
            later = case_starts[case_starts > midpoint].index
            if len(earlier) > 10 and len(later) > 10:
                dur_early = float(case_durations.reindex(earlier).mean())
                dur_late = float(case_durations.reindex(later).mean())
                if dur_early > 0 and dur_late > 0:
                    drift = (dur_late - dur_early) / dur_early
                    if abs(drift) > 0.3:  # 30% shift
                        direction = 'slower' if drift > 0 else 'faster'
                        insights.append({
                            'category': 'drift',
                            'severity': 'warning' if abs(drift) > 0.5 else 'info',
                            'title': f'Process is getting {direction} over time',
                            'description': (
                                f'The second half of the log averages {_fmt_dur(dur_late)} per case, '
                                f'compared to {_fmt_dur(dur_early)} in the first half — a {abs(drift)*100:.0f}% shift.'
                            ),
                            'metric_value': drift,
                            'recommendation': 'Concept drift means the mining results mix two different process realities. Consider re-running the analyses on the later half only to see what the current process actually looks like.',
                        })
    except Exception:
        pass

    # ── 23. Data-quality timestamp problems ──────────────────────────────
    # Ties (multiple events at the same timestamp) and inversions
    # (earlier timestamp after a later one in the same case) corrupt
    # every downstream ordering. We report a quick count so users know
    # their log needs repair before trusting the mining output.
    try:
        ts = pd.to_datetime(df[TIMESTAMP_COL], errors='coerce')
        if ts.notna().sum() > 0:
            # Build a minimal frame with only the two columns we need (avoids
            # copying the full wide DataFrame twice via df.assign).
            _slim = df[[CASE_COL, TIMESTAMP_COL]].copy()
            _slim['_ts'] = ts

            # Ties: two events in the same case at the same timestamp.
            # Sort once, then use vectorised groupby().diff() — no per-group lambda.
            _sorted = _slim.sort_values([CASE_COL, '_ts'])
            ties = int((_sorted.groupby(CASE_COL)['_ts'].diff() == pd.Timedelta(0)).sum())

            # Inversions: detect on the ORIGINAL row order (the user may have
            # uploaded an unsorted log). Again, vectorised groupby().diff().
            inversions = int((_slim.groupby(CASE_COL)['_ts'].diff() < pd.Timedelta(0)).sum())
            if ties + inversions > 0 and (ties + inversions) / max(len(ts), 1) > 0.01:
                pct = (ties + inversions) / max(len(ts), 1) * 100
                insights.append({
                    'category': 'data_quality',
                    'severity': 'warning' if pct > 5 else 'info',
                    'title': f'Timestamp issues affect {pct:.1f}% of events',
                    'description': (
                        f'{ties:,} events share a timestamp with the previous event in the same case, '
                        f'and {inversions:,} events appear out of chronological order.'
                    ),
                    'metric_value': pct,
                    'recommendation': 'Run the timestamp-repair tool from the event log settings before trusting ordering-sensitive analyses (EFG, bottlenecks, temporal profile).',
                })
    except Exception:
        pass

    # ── 24. Activity coverage by resource group ──────────────────────────
    # If a single resource group handles a wildly disproportionate
    # share of the total workload, that's a capacity risk.
    try:
        if RESOURCE_COL in df.columns and df[RESOURCE_COL].notna().sum() > 0:
            res_counts = df[RESOURCE_COL].value_counts()
            if len(res_counts) >= 3:
                top_share = res_counts.iloc[0] / res_counts.sum() * 100
                if top_share > 40:
                    insights.append({
                        'category': 'resource',
                        'severity': 'warning' if top_share > 60 else 'info',
                        'title': f'"{res_counts.index[0]}" handles {top_share:.0f}% of all events',
                        'description': (
                            f'Out of {len(res_counts)} resources, the top one is responsible for '
                            f'{int(res_counts.iloc[0]):,} of {int(res_counts.sum()):,} events.'
                        ),
                        'metric_value': top_share,
                        'recommendation': 'A single resource carrying most of the work is a single point of failure. Check whether this is a shared service account (normal) or a real person (capacity risk).',
                    })
    except Exception:
        pass

    # ── 25. Rare but slow variants (frequency-weighted impact) ───────────
    # A variant that only appears in 2% of cases but takes 10× longer
    # than the median drags the overall avg badly. Surface the worst
    # offender so it gets investigated.
    try:
        if variant_result:
            variants = variant_result.get('variants', [])
            if len(variants) >= 5:
                median_dur = float(pd.Series([
                    v.get('avg_duration') or 0 for v in variants if v.get('avg_duration')
                ]).median())
                worst_rare = None
                worst_score = 0.0
                for v in variants:
                    pct = v.get('percentage', 0)
                    dur = v.get('avg_duration') or 0
                    if pct < 10 and dur > 0 and median_dur > 0 and dur / median_dur > 3:
                        # Score by total wasted time
                        score = v.get('case_count', 0) * (dur - median_dur)
                        if score > worst_score:
                            worst_score = score
                            worst_rare = v
                if worst_rare:
                    ratio = (worst_rare.get('avg_duration') or 0) / max(median_dur, 1)
                    cc = worst_rare.get('case_count', 0)
                    insights.append({
                        'category': 'variant',
                        'severity': 'warning',
                        'title': f'Rare variant {ratio:.1f}x slower than the median',
                        'description': (
                            f'A variant covering only {worst_rare.get("percentage", 0):.1f}% of cases ({cc} cases) '
                            f'averages {_fmt_dur(worst_rare.get("avg_duration") or 0)} — '
                            f'{ratio:.1f}x the median variant.'
                        ),
                        'metric_value': ratio,
                        'recommendation': 'Rare-but-slow variants are usually exception-handling paths. Check whether they deserve their own SLA or can be eliminated by fixing the upstream trigger.',
                        'related_activities': (worst_rare.get('activities') or [])[:5],
                        'impact_estimate': f'Eliminating this variant would save ~{_fmt_dur(worst_score / max(cc, 1))} per affected case.',
                    })
    except Exception:
        pass

    # ── Sort & summarize ─────────────────────────────────────────────────
    severity_order = {'critical': 0, 'warning': 1, 'info': 2}
    insights.sort(key=lambda i: severity_order.get(i['severity'], 9))

    critical_count = sum(1 for i in insights if i['severity'] == 'critical')
    warning_count = sum(1 for i in insights if i['severity'] == 'warning')
    automation_count = sum(1 for i in insights if i['category'] == 'automation')
    root_cause_count = sum(1 for i in insights if i['category'] == 'root_cause')

    summary = f"Your process has {total_activities} activities across {total_cases:,} cases ({total_events:,} events)."
    if critical_count > 0:
        summary += f" We found {critical_count} critical issue{'s' if critical_count > 1 else ''}."
    if warning_count > 0:
        summary += f" {warning_count} warning{'s' if warning_count > 1 else ''} to review."
    if automation_count > 0:
        summary += f" {automation_count} automation opportunit{'ies' if automation_count > 1 else 'y'} identified."
    if root_cause_count > 0:
        summary += " Key root cause factor identified."
    if critical_count == 0 and warning_count == 0:
        summary += " No critical issues detected."

    return {'insights': insights, 'summary': summary}
