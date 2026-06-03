"""
Process-mining report / export router.

Split out of ``app.api.mining`` (which kept the core analytical mining
routes). This module owns the printable / exported report endpoints:

  * GET /mining/conformance/{event_log_id}/pdf  — reportlab-rendered PDF
  * GET /mining/report/{event_log_id}            — self-contained HTML report

The router mounts at the SAME ``/api/v1/mining`` prefix as ``app.api.mining``
(FastAPI allows multiple routers per prefix), so every route path and
response shape is byte-identical to before the split.

Shared mining access/cache/load helpers live in ``app.api._mining_deps``
(the api-deps layer, Phase 5) and the discovery engine lives in
``app.services.mining_engine``; both are imported here directly. Neither
imports this module, so there is no import cycle.
"""

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import User
from app.api.deps import get_current_active_user
from app.schemas.mining import ReportResponse
from app.services.mining_engine import mining_engine
from app.api._mining_deps import (
    _assert_event_log_access,
    _get_cached,
    _load_event_log_and_df,
    _run_in_thread,
    _set_cached,
)

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/conformance/{event_log_id}/pdf")
async def conformance_pdf(
    event_log_id: UUID,
    method: str = Query(
        default="alignment",
        description="Conformance method used to build the report",
    ),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Generate a standardized PDF conformance report.

    Emits a reproducible layout — overview, fitness/precision/generalization
    gauges, per-case compliance count, deviation breakdown, and methodology —
    so reports can be compared across runs, tools, and teams.
    """
    from io import BytesIO
    from datetime import datetime, timezone
    from fastapi.responses import StreamingResponse

    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.platypus import (
            SimpleDocTemplate,
            Paragraph,
            Spacer,
            Table,
            TableStyle,
            PageBreak,
        )
    except ImportError:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="reportlab is not installed — add it to requirements.txt and rebuild.",
        )

    if method not in {"auto", "token_replay", "alignment", "decomposed", "footprints", "jsd"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="method must be one of: auto, token_replay, alignment, decomposed, footprints, jsd",
        )

    await _assert_event_log_access(event_log_id, db, current_user)
    event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    cache_params = {"reference_model": None, "method": method}
    cached = _get_cached(event_log_id, "conformance", cache_params)
    if cached is not None:
        result = cached
    else:
        try:
            result = await _run_in_thread(
                mining_engine.run_conformance,
                df,
                reference_model=None,
                method=method,
            )
        except Exception as e:
            logger.error("Conformance checking failed for PDF export: %s", e, exc_info=True)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Conformance checking failed: {e}",
            )
        _set_cached(event_log_id, "conformance", result, cache_params)

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=20 * mm,
        bottomMargin=20 * mm,
        title=f"FlowMiner Conformance Report — {event_log.name}",
        author="FlowMiner",
    )

    styles = getSampleStyleSheet()
    h1 = ParagraphStyle(
        "H1",
        parent=styles["Heading1"],
        fontSize=18,
        spaceAfter=6,
        textColor=colors.HexColor("#0f172a"),
    )
    h2 = ParagraphStyle(
        "H2",
        parent=styles["Heading2"],
        fontSize=13,
        spaceBefore=12,
        spaceAfter=4,
        textColor=colors.HexColor("#0f172a"),
    )
    body = ParagraphStyle(
        "Body",
        parent=styles["BodyText"],
        fontSize=9,
        leading=12,
        textColor=colors.HexColor("#1e293b"),
    )
    mono = ParagraphStyle(
        "Mono",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=8,
        textColor=colors.HexColor("#475569"),
    )

    story: list = []

    story.append(Paragraph("FlowMiner Conformance Report", h1))
    story.append(
        Paragraph(
            f"Event log: <b>{event_log.name}</b> · "
            f"Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}",
            body,
        )
    )
    story.append(Spacer(1, 6))

    # Summary metrics table — big, easy to scan
    fitness = result.get("fitness") or 0.0
    precision = result.get("precision")
    generalization = result.get("generalization")
    total_cases = result.get("total_cases") or 0
    conformant_cases = result.get("conformant_cases") or 0
    non_conformant = max(0, total_cases - conformant_cases)
    compliance_pct = (conformant_cases / total_cases * 100) if total_cases else 0.0

    def _fmt_score(v):
        if v is None:
            return "—"
        return f"{v:.3f}"

    def _score_color(v):
        if v is None:
            return colors.HexColor("#94a3b8")
        if v >= 0.85:
            return colors.HexColor("#10b981")
        if v >= 0.6:
            return colors.HexColor("#f59e0b")
        return colors.HexColor("#ef4444")

    metrics_data = [
        ["Metric", "Value", "Interpretation"],
        ["Fitness", _fmt_score(fitness), _fitness_interpretation(fitness)],
        ["Precision", _fmt_score(precision), _precision_interpretation(precision)],
        ["Generalization", _fmt_score(generalization), _generalization_interpretation(generalization)],
        ["Simplicity", "—", "Not computed in this run."],
    ]
    metrics_table = Table(
        metrics_data,
        colWidths=[35 * mm, 25 * mm, 110 * mm],
    )
    metrics_table.setStyle(
        TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1e293b")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("ALIGN", (1, 0), (1, -1), "RIGHT"),
            ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#f8fafc")),
            ("TEXTCOLOR", (1, 1), (1, 1), _score_color(fitness)),
            ("TEXTCOLOR", (1, 2), (1, 2), _score_color(precision)),
            ("TEXTCOLOR", (1, 3), (1, 3), _score_color(generalization)),
            ("FONTNAME", (1, 1), (1, -1), "Helvetica-Bold"),
            ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#cbd5e1")),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
            ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ])
    )
    story.append(metrics_table)
    story.append(Spacer(1, 10))

    # Case-level compliance block
    story.append(Paragraph("Case-level compliance", h2))
    compliance_data = [
        ["Total cases", f"{total_cases:,}"],
        ["Conformant cases", f"{conformant_cases:,}"],
        ["Non-conformant cases", f"{non_conformant:,}"],
        ["Compliance rate", f"{compliance_pct:.1f}%"],
    ]
    compliance_table = Table(compliance_data, colWidths=[60 * mm, 40 * mm])
    compliance_table.setStyle(
        TableStyle([
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("ALIGN", (1, 0), (1, -1), "RIGHT"),
            ("FONTNAME", (0, 0), (0, -1), "Helvetica"),
            ("FONTNAME", (1, 0), (1, -1), "Helvetica-Bold"),
            ("LINEBELOW", (0, 0), (-1, -2), 0.25, colors.HexColor("#e2e8f0")),
            ("TEXTCOLOR", (0, 0), (-1, -1), colors.HexColor("#334155")),
            ("LEFTPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ])
    )
    story.append(compliance_table)
    story.append(Spacer(1, 10))

    # Deviation breakdown
    deviations = result.get("deviations") or []
    story.append(Paragraph("Deviations", h2))
    if not deviations:
        story.append(Paragraph("No deviations detected — every case is conformant.", body))
    else:
        # Count by type
        counts: dict[str, int] = {}
        activity_counts: dict[str, int] = {}
        for d in deviations:
            dtype = d.get("deviation_type") or "unknown"
            counts[dtype] = counts.get(dtype, 0) + 1
            activity = d.get("activity")
            if activity:
                activity_counts[activity] = activity_counts.get(activity, 0) + 1

        breakdown_rows = [["Type", "Count", "Share"]]
        total_dev = sum(counts.values()) or 1
        for dtype, cnt in sorted(counts.items(), key=lambda x: -x[1]):
            pct = cnt / total_dev * 100
            breakdown_rows.append([dtype.replace("_", " ").title(), f"{cnt:,}", f"{pct:.1f}%"])
        breakdown_table = Table(breakdown_rows, colWidths=[70 * mm, 30 * mm, 30 * mm])
        breakdown_table.setStyle(
            TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
                ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#cbd5e1")),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ])
        )
        story.append(breakdown_table)
        story.append(Spacer(1, 8))

        if activity_counts:
            story.append(Paragraph("Top activities involved in deviations", h2))
            top_activities = sorted(activity_counts.items(), key=lambda x: -x[1])[:10]
            act_rows = [["Activity", "Deviation count"]]
            for act, cnt in top_activities:
                act_rows.append([act, f"{cnt:,}"])
            act_table = Table(act_rows, colWidths=[100 * mm, 30 * mm])
            act_table.setStyle(
                TableStyle([
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
                    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                    ("FONTSIZE", (0, 0), (-1, -1), 9),
                    ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
                    ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#cbd5e1")),
                    ("LEFTPADDING", (0, 0), (-1, -1), 6),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                    ("TOPPADDING", (0, 0), (-1, -1), 4),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ])
            )
            story.append(act_table)
            story.append(Spacer(1, 8))

    # Methodology — critical for comparability across runs/tools
    story.append(PageBreak())
    story.append(Paragraph("Methodology", h1))
    story.append(
        Paragraph(
            f"This report was generated by FlowMiner using the "
            f"<b>{method}</b> conformance method. The reference process "
            "model was discovered from the event log via the pm4py "
            "Inductive Miner unless a reference model was explicitly "
            "provided.",
            body,
        )
    )
    story.append(Spacer(1, 6))
    story.append(
        Paragraph(
            "<b>Fitness</b> measures how well the event log can be replayed "
            "on the model. 1.0 means every case replays without deviation. "
            "Token-replay fitness is fast but imprecise on models with "
            "invisible transitions; alignment-based fitness is strictly more "
            "accurate but ~10–100× slower.",
            body,
        )
    )
    story.append(Spacer(1, 4))
    story.append(
        Paragraph(
            "<b>Precision</b> measures how much additional behavior the "
            "model allows beyond what's observed in the log. 1.0 means the "
            "model is tight; 0.0 means it allows any sequence.",
            body,
        )
    )
    story.append(Spacer(1, 4))
    story.append(
        Paragraph(
            "<b>Generalization</b> measures how well the model handles "
            "unseen behavior. High generalization correlates with low "
            "overfitting.",
            body,
        )
    )
    story.append(Spacer(1, 10))
    story.append(
        Paragraph(
            f"Report ID: <font name='Helvetica-Bold'>{event_log_id}</font> · "
            f"Events: {len(df):,} · Cases: {total_cases:,} · "
            f"Method: {method}",
            mono,
        )
    )

    doc.build(story)
    buf.seek(0)

    filename = f"conformance_{event_log.name.replace(' ', '_')}_{method}.pdf"
    return StreamingResponse(
        buf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _fitness_interpretation(v):
    if v is None:
        return "Could not compute."
    if v >= 0.95:
        return "Excellent — model replays almost perfectly."
    if v >= 0.85:
        return "Good — minor deviations present."
    if v >= 0.6:
        return "Fair — significant deviations; investigate."
    return "Poor — the model does not match reality."


def _precision_interpretation(v):
    if v is None:
        return "Not computed (common for alignment-based runs)."
    if v >= 0.85:
        return "Tight model — allows only observed behavior."
    if v >= 0.6:
        return "Loose model — some unused paths."
    return "Underfitting — model permits too much behavior."


def _generalization_interpretation(v):
    if v is None:
        return "Not computed for this method."
    if v >= 0.85:
        return "Generalizes well to unseen cases."
    if v >= 0.6:
        return "Moderate generalization."
    return "Overfits the log — may miss legitimate variation."


@router.get("/report/{event_log_id}", response_model=ReportResponse)
async def generate_report(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """
    Generate an HTML process mining report for the event log.

    Runs statistics, variant analysis, and bottleneck analysis then returns
    a self-contained HTML string with inline CSS. The frontend can open this
    in a new window and call window.print() to produce a PDF.
    """
    await _assert_event_log_access(event_log_id, db, current_user)
    cached = _get_cached(event_log_id, "report")
    if cached is not None:
        return ReportResponse(**cached)

    event_log, df = await _load_event_log_and_df(event_log_id, db, current_user)

    try:
        from datetime import date

        stats_raw = await _run_in_thread(mining_engine.compute_statistics, df)
        variants_raw = await _run_in_thread(mining_engine.run_variant_analysis, df)
        bottlenecks_raw = await _run_in_thread(mining_engine.run_bottleneck_analysis, df)
    except Exception as e:
        logger.error(f"Report generation failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Report generation failed: {str(e)}",
        )

    def _fmt_duration(seconds: float | None) -> str:
        if seconds is None:
            return "N/A"
        if seconds < 60:
            return f"{seconds:.1f}s"
        if seconds < 3600:
            return f"{seconds / 60:.1f}m"
        if seconds < 86400:
            return f"{seconds / 3600:.1f}h"
        return f"{seconds / 86400:.1f}d"

    log_name = event_log.name
    report_date = date.today().isoformat()

    # --- Summary stats table ---
    total_cases = stats_raw.get("total_cases", 0)
    total_events = stats_raw.get("total_events", 0)
    total_activities = stats_raw.get("total_activities", 0)
    avg_dur = _fmt_duration(stats_raw.get("avg_case_duration"))

    stats_rows = "".join(
        f"<tr><td>{label}</td><td><strong>{value}</strong></td></tr>"
        for label, value in [
            ("Total Cases", f"{total_cases:,}"),
            ("Total Events", f"{total_events:,}"),
            ("Unique Activities", f"{total_activities:,}"),
            ("Avg Case Duration", avg_dur),
            ("Median Case Duration", _fmt_duration(stats_raw.get("median_case_duration"))),
            ("Min Case Duration", _fmt_duration(stats_raw.get("min_case_duration"))),
            ("Max Case Duration", _fmt_duration(stats_raw.get("max_case_duration"))),
        ]
    )

    # --- Top 5 variants ---
    top_variants = variants_raw.get("variants", [])[:5]
    variant_rows = ""
    for v in top_variants:
        activities_flow = " &rarr; ".join(v.get("activities", []))
        freq = v.get("frequency", 0)
        pct = v.get("percentage", 0.0)
        avg_v = _fmt_duration(v.get("avg_duration"))
        variant_rows += (
            f"<tr>"
            f"<td style='word-break:break-word;max-width:400px'>{activities_flow}</td>"
            f"<td style='text-align:center'>{freq:,}</td>"
            f"<td style='text-align:center'>{pct:.1f}%</td>"
            f"<td style='text-align:center'>{avg_v}</td>"
            f"</tr>"
        )
    if not variant_rows:
        variant_rows = "<tr><td colspan='4' style='text-align:center;color:#888'>No variants found</td></tr>"

    # --- Bottleneck table ---
    bottlenecks = bottlenecks_raw.get("bottlenecks", [])
    bottleneck_rows = ""
    severity_colors = {
        "critical": "#c0392b",
        "high": "#e67e22",
        "medium": "#f39c12",
        "low": "#27ae60",
    }
    for b in bottlenecks:
        color = severity_colors.get(b.get("severity", "low"), "#27ae60")
        flag = " &#9888;" if b.get("is_bottleneck") else ""
        bottleneck_rows += (
            f"<tr>"
            f"<td>{b.get('activity', '')}{flag}</td>"
            f"<td style='text-align:center'>{_fmt_duration(b.get('avg_duration'))}</td>"
            f"<td style='text-align:center'>{b.get('frequency', 0):,}</td>"
            f"<td style='text-align:center;color:{color};font-weight:bold'>"
            f"{b.get('severity', '').capitalize()}</td>"
            f"</tr>"
        )
    if not bottleneck_rows:
        bottleneck_rows = (
            "<tr><td colspan='4' style='text-align:center;color:#888'>No bottleneck data</td></tr>"
        )

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>FlowMiner Report — {log_name}</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px;
         color: #222; background: #fff; padding: 32px 40px; }}
  h1 {{ font-size: 22px; color: #1a2e4a; margin-bottom: 4px; }}
  h2 {{ font-size: 15px; color: #1a2e4a; margin: 28px 0 10px; border-bottom: 2px solid #3498db;
        padding-bottom: 4px; }}
  .meta {{ font-size: 12px; color: #666; margin-bottom: 24px; }}
  table {{ width: 100%; border-collapse: collapse; margin-bottom: 8px; }}
  th {{ background: #2c3e50; color: #fff; padding: 8px 10px; text-align: left;
        font-size: 12px; }}
  td {{ padding: 7px 10px; border-bottom: 1px solid #e8e8e8; vertical-align: top; }}
  tr:nth-child(even) td {{ background: #f7f9fc; }}
  .score-badge {{ display: inline-block; padding: 2px 10px; border-radius: 12px;
                  font-weight: bold; font-size: 12px; }}
  footer {{ margin-top: 40px; padding-top: 12px; border-top: 1px solid #ddd;
            font-size: 11px; color: #999; text-align: center; }}
  @media print {{
    body {{ padding: 16px 20px; }}
    h2 {{ page-break-after: avoid; }}
    table {{ page-break-inside: avoid; }}
  }}
</style>
</head>
<body>
<h1>Process Mining Report</h1>
<p class="meta">
  <strong>Event Log:</strong> {log_name} &nbsp;&bull;&nbsp;
  <strong>Generated:</strong> {report_date} &nbsp;&bull;&nbsp;
  <strong>Generated by:</strong> FlowMiner
</p>

<h2>Summary Statistics</h2>
<table>
  <thead><tr><th>Metric</th><th>Value</th></tr></thead>
  <tbody>{stats_rows}</tbody>
</table>

<h2>Top 5 Process Variants</h2>
<table>
  <thead>
    <tr>
      <th>Activity Flow</th>
      <th style="text-align:center">Cases</th>
      <th style="text-align:center">Coverage</th>
      <th style="text-align:center">Avg Duration</th>
    </tr>
  </thead>
  <tbody>{variant_rows}</tbody>
</table>

<h2>Bottleneck Analysis</h2>
<table>
  <thead>
    <tr>
      <th>Activity</th>
      <th style="text-align:center">Avg Duration</th>
      <th style="text-align:center">Frequency</th>
      <th style="text-align:center">Severity</th>
    </tr>
  </thead>
  <tbody>{bottleneck_rows}</tbody>
</table>

<footer>Generated by <strong>FlowMiner</strong> &mdash; Open-source Process Mining Platform &mdash; {report_date}</footer>
</body>
</html>"""

    result = {"html": html, "event_log_name": log_name}
    _set_cached(event_log_id, "report", result)
    return ReportResponse(**result)
