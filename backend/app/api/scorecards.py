"""Cost-of-quality scoreboards, workflow exports, and DP benchmarks.

Three endpoints that each close a small gap in the competitive matrix:
  - GET /scorecards/cost-of-quality/{event_log_id} — rework + escalation
    + bottleneck cost in dollars, updated on demand.
  - GET /scorecards/export-workflow/{event_log_id} — emit the happy
    path as a Temporal Python skeleton, n8n JSON, or Airflow DAG.
  - POST /scorecards/dp-benchmark — cross-team federated stats with
    Laplace-noise differential privacy.
"""

from __future__ import annotations

import json
import math
import random
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_active_user
from app.api._mining_deps import _assert_event_log_access, _load_event_log_and_df, _run_in_thread
from app.database import get_db
from app.models import User
from app.services.mining_engine import mining_engine

router = APIRouter()


# ─── 5.8 Cost-of-quality scoreboard ──────────────────────────────────────


class CostInputs(BaseModel):
    fte_cost_per_hour: float = 50.0
    cost_per_rework_case: float = 25.0
    cost_per_escalation: float = 100.0


@router.post("/cost-of-quality/{event_log_id}")
async def cost_of_quality(
    event_log_id: UUID,
    body: CostInputs,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Dollar cost of quality issues on this event log.

    Computes:
      - rework_cost = rework_cases × cost_per_rework_case
      - bottleneck_queue_cost = sum(bottleneck queue hours × fte_cost_per_hour)
      - escalation_cost = escalation count × cost_per_escalation

    Returns a single number plus the line-item breakdown. Intended for
    the project overview card.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    rework_info = await _run_in_thread(mining_engine.get_rework, df)
    bottleneck_info = await _run_in_thread(mining_engine.run_bottleneck_analysis, df)

    rework_cases = int(rework_info.get("cases_with_rework", 0))
    rework_cost = rework_cases * body.cost_per_rework_case

    bottleneck_hours = 0.0
    for b in bottleneck_info.get("bottlenecks", [])[:10]:
        dur_sec = float(b.get("avg_duration", 0) or 0)
        freq = int(b.get("frequency", 0) or 0)
        bottleneck_hours += (dur_sec / 3600) * freq
    bottleneck_cost = bottleneck_hours * body.fte_cost_per_hour

    # Rough escalation heuristic: count activities with "escalat" in the name
    escalation_count = 0
    for b in bottleneck_info.get("bottlenecks", []):
        name = str(b.get("activity", "")).lower()
        if "escalat" in name:
            escalation_count += int(b.get("frequency", 0) or 0)
    escalation_cost = escalation_count * body.cost_per_escalation

    total = rework_cost + bottleneck_cost + escalation_cost

    return {
        "total": round(total, 2),
        "line_items": [
            {"label": "Rework", "value": round(rework_cost, 2), "detail": f"{rework_cases} cases"},
            {"label": "Bottleneck queues", "value": round(bottleneck_cost, 2), "detail": f"{bottleneck_hours:.1f} FTE hours"},
            {"label": "Escalations", "value": round(escalation_cost, 2), "detail": f"{escalation_count} events"},
        ],
        "inputs": body.model_dump(),
    }


# ─── 5.5 Process-to-code export ─────────────────────────────────────────


@router.get("/export-workflow/{event_log_id}")
async def export_workflow(
    event_log_id: UUID,
    target: str = Query("temporal", pattern="^(temporal|n8n|airflow)$"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Emit the happy-path variant as executable workflow code.

    Supported targets:
      - ``temporal``: a Python skeleton with one ``@activity.defn`` per
        mined activity and a ``@workflow.defn`` that chains them.
      - ``n8n``:    a JSON import for the n8n workflow engine.
      - ``airflow``: a Python Airflow DAG file with PythonOperator nodes.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    _event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    variant_result = await _run_in_thread(mining_engine.run_variant_analysis, df)
    top_variant = (variant_result.get("variants") or [{}])[0]
    activities: list[str] = top_variant.get("activities") or []

    if not activities:
        raise HTTPException(status_code=400, detail="No happy path to export")

    def _slug(s: str) -> str:
        import re
        return re.sub(r"[^a-zA-Z0-9_]+", "_", s).strip("_").lower() or "step"

    if target == "temporal":
        activity_defs = "\n\n".join(
            f"@activity.defn\nasync def {_slug(a)}() -> None:\n    '''TODO: implement {a}'''\n    pass"
            for a in activities
        )
        calls = "\n    ".join(f"await workflow.execute_activity({_slug(a)}, start_to_close_timeout=timedelta(hours=1))" for a in activities)
        code = (
            "from datetime import timedelta\n"
            "from temporalio import activity, workflow\n\n"
            f"{activity_defs}\n\n"
            "@workflow.defn\n"
            "class FlowMinerWorkflow:\n"
            "    @workflow.run\n"
            "    async def run(self) -> None:\n"
            f"    {calls}\n"
        )
        return {"target": target, "code": code, "language": "python"}

    if target == "airflow":
        defs = "\n\n".join(
            f"def {_slug(a)}():\n    '''TODO: implement {a}'''\n    pass"
            for a in activities
        )
        tasks = "\n    ".join(
            f"t_{i} = PythonOperator(task_id='{_slug(a)}', python_callable={_slug(a)})"
            for i, a in enumerate(activities)
        )
        chain = " >> ".join(f"t_{i}" for i in range(len(activities)))
        code = (
            "from datetime import datetime\n"
            "from airflow import DAG\n"
            "from airflow.operators.python import PythonOperator\n\n"
            f"{defs}\n\n"
            "with DAG('flowminer_happy_path', start_date=datetime(2026,1,1), schedule=None, catchup=False) as dag:\n"
            f"    {tasks}\n"
            f"    {chain}\n"
        )
        return {"target": target, "code": code, "language": "python"}

    # n8n JSON
    nodes = []
    connections: dict[str, dict] = {}
    for i, a in enumerate(activities):
        nid = _slug(a) + f"_{i}"
        nodes.append({
            "parameters": {},
            "id": nid,
            "name": a,
            "type": "n8n-nodes-base.function",
            "typeVersion": 1,
            "position": [250 + i * 200, 300],
        })
        if i > 0:
            prev = nodes[i - 1]["name"]
            connections.setdefault(prev, {"main": [[]]})["main"][0].append({"node": a, "type": "main", "index": 0})
    n8n_json = {"name": "FlowMiner happy path", "nodes": nodes, "connections": connections}
    return {"target": target, "code": json.dumps(n8n_json, indent=2), "language": "json"}


# ─── 5.10 Differential privacy cross-team benchmark ──────────────────────


class DPBenchmarkRequest(BaseModel):
    event_log_ids: list[UUID]
    epsilon: float = 1.0  # Lower = more privacy, more noise


def _laplace_noise(scale: float) -> float:
    u = random.random() - 0.5
    return -scale * (1 if u >= 0 else -1) * math.log(1 - 2 * abs(u))


@router.post("/dp-benchmark")
async def dp_benchmark(
    body: DPBenchmarkRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Cross-team benchmark with differential-privacy noise.

    Computes average case duration and case count for each event log
    with calibrated Laplace noise applied per the epsilon budget. No
    raw case data ever leaves the caller's log.
    """
    if not body.event_log_ids:
        raise HTTPException(status_code=400, detail="At least one event_log_id required")
    if body.epsilon <= 0:
        raise HTTPException(status_code=400, detail="epsilon must be > 0")

    # Sensitivity: removing one case changes the mean by at most
    # (max_duration / n). We use a conservative max of 7 days (604800s).
    max_duration = 604800
    results = []
    for el_id in body.event_log_ids:
        try:
            await _assert_event_log_access(el_id, db, current_user)
            _el, df = await _load_event_log_and_df(el_id, db, current_user)
            stats = await _run_in_thread(mining_engine.compute_statistics, df)
        except Exception:
            continue
        n = int(stats.get("total_cases", 0) or 1)
        mean_dur = float(stats.get("avg_case_duration_seconds", 0) or 0)
        sensitivity_mean = max_duration / max(n, 1)
        scale_mean = sensitivity_mean / body.epsilon
        # Count sensitivity is 1
        scale_count = 1 / body.epsilon
        results.append({
            "event_log_id": str(el_id),
            "dp_avg_case_duration_seconds": max(0, mean_dur + _laplace_noise(scale_mean)),
            "dp_case_count": max(0, int(n + _laplace_noise(scale_count))),
            "epsilon_used": body.epsilon,
            "noise_scale_mean": round(scale_mean, 2),
            "noise_scale_count": round(scale_count, 2),
        })
    return {
        "epsilon": body.epsilon,
        "count": len(results),
        "results": results,
        "note": (
            "Values include Laplace noise calibrated to the epsilon budget. "
            "Smaller epsilon means more privacy and noisier values."
        ),
    }
