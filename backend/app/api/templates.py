"""
Process template router: list, retrieve, create, and seed built-in templates.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import ProcessTemplate, User
from app.api.deps import get_current_active_user, require_admin, require_analyst

router = APIRouter()


# -- Inline schemas for templates --

class TemplateCreate(BaseModel):
    name: str = Field(..., min_length=1, description="Template name")
    category: str = Field(..., min_length=1, description="Template category")
    description: str | None = Field(default=None, description="Template description")
    reference_model: dict = Field(default={}, description="Reference process model")
    expected_activities: list[str] = Field(default=[], description="Expected activities in order")
    kpis: list[dict] = Field(default=[], description="KPI definitions")
    anti_patterns: list[dict] = Field(default=[], description="Anti-pattern definitions")


class TemplateResponse(BaseModel):
    id: UUID
    name: str
    category: str
    description: str | None = None
    reference_model: dict = {}
    expected_activities: list[str] = []
    kpis: list[dict] = []
    anti_patterns: list[dict] = []
    is_builtin: bool = False
    created_at: object = None

    class Config:
        from_attributes = True


@router.get("", response_model=list[TemplateResponse])
async def list_templates(
    category: str | None = Query(default=None, description="Filter by category"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_active_user),
):
    """List all process templates, optionally filtered by category."""
    query = select(ProcessTemplate)
    if category is not None:
        query = query.where(ProcessTemplate.category == category)
    query = query.order_by(ProcessTemplate.name).limit(limit).offset(offset)

    result = await db.execute(query)
    templates = result.scalars().all()
    return templates


@router.get("/{template_id}", response_model=TemplateResponse)
async def get_template(
    template_id: UUID,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_active_user),
):
    """Get a process template by ID."""
    result = await db.execute(
        select(ProcessTemplate).where(ProcessTemplate.id == template_id)
    )
    template = result.scalar_one_or_none()
    if template is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Template not found"
        )
    return template


@router.post("", response_model=TemplateResponse, status_code=status.HTTP_201_CREATED)
async def create_template(
    body: TemplateCreate,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(require_analyst),
):
    """Create a custom process template. Requires analyst or admin role."""
    template = ProcessTemplate(
        name=body.name,
        category=body.category,
        description=body.description,
        reference_model=body.reference_model,
        expected_activities=body.expected_activities,
        kpis=body.kpis,
        anti_patterns=body.anti_patterns,
        is_builtin=False,
    )
    db.add(template)
    await db.commit()
    await db.refresh(template)
    return template


@router.post("/seed", status_code=status.HTTP_201_CREATED)
async def seed_templates(
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """
    Seed the database with built-in process templates. Admin only.
    Skips templates that already exist (matched by name).
    """
    builtin_templates = [
        {
            "name": "Order-to-Cash (O2C)",
            "category": "finance",
            "description": "Standard order-to-cash business process covering order creation through payment receipt.",
            "expected_activities": [
                "Create Order",
                "Approve Order",
                "Pick Items",
                "Ship Items",
                "Invoice",
                "Payment Received",
            ],
            "kpis": [
                {
                    "name": "Order Cycle Time",
                    "metric": "avg_cycle_time",
                    "target": 72,
                    "unit": "hours",
                },
                {
                    "name": "On-Time Delivery",
                    "metric": "sla_compliance",
                    "target": 95,
                    "unit": "percent",
                },
            ],
            "anti_patterns": [
                {
                    "name": "Rework Loop",
                    "pattern": "repeated_activity",
                    "description": "Order requires multiple approvals",
                },
                {
                    "name": "Skipped Shipping",
                    "pattern": "missing_activity",
                    "activity": "Ship Items",
                    "description": "Items invoiced without shipping confirmation",
                },
            ],
        },
        {
            "name": "Purchase-to-Pay (P2P)",
            "category": "finance",
            "description": "Purchase-to-pay process from requisition through payment.",
            "expected_activities": [
                "Create Purchase Requisition",
                "Approve Requisition",
                "Create Purchase Order",
                "Receive Goods",
                "Receive Invoice",
                "Process Payment",
            ],
            "kpis": [
                {
                    "name": "Procurement Cycle Time",
                    "metric": "avg_cycle_time",
                    "target": 168,
                    "unit": "hours",
                },
                {
                    "name": "Maverick Buying Rate",
                    "metric": "rework_rate",
                    "target": 5,
                    "unit": "percent",
                },
            ],
            "anti_patterns": [
                {
                    "name": "Approval Bypass",
                    "pattern": "missing_activity",
                    "activity": "Approve Requisition",
                    "description": "Purchase made without requisition approval",
                },
                {
                    "name": "Invoice Before Receipt",
                    "pattern": "wrong_order",
                    "activities": ["Receive Invoice", "Receive Goods"],
                    "description": "Invoice processed before goods are received",
                },
            ],
        },
        {
            "name": "Incident Management (ITSM)",
            "category": "it",
            "description": "IT service management incident resolution process.",
            "expected_activities": [
                "Open Incident",
                "Classify",
                "Assign",
                "Investigate",
                "Resolve",
                "Close",
            ],
            "kpis": [
                {
                    "name": "Mean Time to Resolve",
                    "metric": "avg_cycle_time",
                    "target": 24,
                    "unit": "hours",
                },
                {
                    "name": "First-Contact Resolution Rate",
                    "metric": "sla_compliance",
                    "target": 70,
                    "unit": "percent",
                },
            ],
            "anti_patterns": [
                {
                    "name": "Escalation Loop",
                    "pattern": "repeated_activity",
                    "description": "Incident reassigned multiple times without resolution",
                },
                {
                    "name": "Skipped Classification",
                    "pattern": "missing_activity",
                    "activity": "Classify",
                    "description": "Incident assigned without proper classification",
                },
            ],
        },
        {
            "name": "Customer Support",
            "category": "support",
            "description": "Customer support ticket lifecycle from creation to closure.",
            "expected_activities": [
                "Ticket Created",
                "Assign Agent",
                "First Response",
                "Investigation",
                "Resolution",
                "Customer Confirmation",
                "Close Ticket",
            ],
            "kpis": [
                {
                    "name": "First Response Time",
                    "metric": "avg_cycle_time",
                    "target": 4,
                    "unit": "hours",
                },
                {
                    "name": "Customer Satisfaction",
                    "metric": "sla_compliance",
                    "target": 90,
                    "unit": "percent",
                },
            ],
            "anti_patterns": [
                {
                    "name": "Ping-Pong Reassignment",
                    "pattern": "repeated_activity",
                    "description": "Ticket reassigned between agents multiple times",
                },
                {
                    "name": "Missing Confirmation",
                    "pattern": "missing_activity",
                    "activity": "Customer Confirmation",
                    "description": "Ticket closed without customer confirmation",
                },
            ],
        },
        {
            "name": "Employee Onboarding",
            "category": "hr",
            "description": "New employee onboarding process from offer acceptance through first review.",
            "expected_activities": [
                "Offer Accepted",
                "Background Check",
                "IT Setup",
                "Orientation",
                "Training",
                "First Review",
            ],
            "kpis": [
                {
                    "name": "Onboarding Cycle Time",
                    "metric": "avg_cycle_time",
                    "target": 336,
                    "unit": "hours",
                },
                {
                    "name": "Completion Rate",
                    "metric": "sla_compliance",
                    "target": 95,
                    "unit": "percent",
                },
            ],
            "anti_patterns": [
                {
                    "name": "Skipped Background Check",
                    "pattern": "missing_activity",
                    "activity": "Background Check",
                    "description": "Employee starts without completed background check",
                },
                {
                    "name": "Delayed IT Setup",
                    "pattern": "wrong_order",
                    "activities": ["IT Setup", "Orientation"],
                    "description": "IT equipment not ready before orientation day",
                },
            ],
        },
        {
            "name": "Insurance Claims",
            "category": "insurance",
            "description": "Insurance claim processing from filing through settlement.",
            "expected_activities": [
                "Claim Filed",
                "Document Collection",
                "Assessment",
                "Approval",
                "Payment",
                "Close Claim",
            ],
            "kpis": [
                {
                    "name": "Claim Processing Time",
                    "metric": "avg_cycle_time",
                    "target": 240,
                    "unit": "hours",
                },
                {
                    "name": "Straight-Through Processing Rate",
                    "metric": "sla_compliance",
                    "target": 60,
                    "unit": "percent",
                },
            ],
            "anti_patterns": [
                {
                    "name": "Document Re-request",
                    "pattern": "repeated_activity",
                    "description": "Documents requested from claimant multiple times",
                },
                {
                    "name": "Payment Without Approval",
                    "pattern": "missing_activity",
                    "activity": "Approval",
                    "description": "Claim paid without formal approval step",
                },
            ],
        },
        {
            "name": "Patient Journey",
            "category": "healthcare",
            "description": "Patient journey through a healthcare facility from registration to follow-up.",
            "expected_activities": [
                "Registration",
                "Triage",
                "Examination",
                "Diagnosis",
                "Treatment",
                "Discharge",
                "Follow-up",
            ],
            "kpis": [
                {
                    "name": "Length of Stay",
                    "metric": "avg_cycle_time",
                    "target": 48,
                    "unit": "hours",
                },
                {
                    "name": "Readmission Rate",
                    "metric": "rework_rate",
                    "target": 10,
                    "unit": "percent",
                },
            ],
            "anti_patterns": [
                {
                    "name": "Skipped Triage",
                    "pattern": "missing_activity",
                    "activity": "Triage",
                    "description": "Patient examined without triage assessment",
                },
                {
                    "name": "Treatment Before Diagnosis",
                    "pattern": "wrong_order",
                    "activities": ["Treatment", "Diagnosis"],
                    "description": "Treatment started before formal diagnosis",
                },
            ],
        },
        # ── Additional industry templates (Tier 1.9 expansion) ────────
        {
            "name": "Loan Origination",
            "category": "banking",
            "description": "End-to-end retail loan origination from application through funding.",
            "expected_activities": [
                "Application Received", "KYC Check", "Credit Check",
                "Underwriting", "Decision", "Offer Sent", "Offer Accepted",
                "Documentation", "Funding",
            ],
            "kpis": [
                {"name": "Application-to-Funding Cycle Time", "metric": "avg_cycle_time", "target": 120, "unit": "hours"},
                {"name": "Decision Rate", "metric": "conformance_rate", "target": 95, "unit": "percent"},
            ],
            "anti_patterns": [
                {"name": "Skipped KYC", "pattern": "missing_activity", "activity": "KYC Check",
                 "description": "Funding proceeded without a KYC check — regulatory risk."},
                {"name": "Multiple Underwriting Rounds", "pattern": "repeated_activity",
                 "description": "Underwriting touched more than twice — inefficient."},
            ],
        },
        {
            "name": "Expense Approval",
            "category": "finance",
            "description": "Employee expense claim submission through reimbursement.",
            "expected_activities": [
                "Submit Expense", "Manager Review", "Finance Review",
                "Approve", "Reimburse",
            ],
            "kpis": [
                {"name": "Claim-to-Reimbursement Cycle", "metric": "avg_cycle_time", "target": 72, "unit": "hours"},
            ],
            "anti_patterns": [
                {"name": "Expense Over Limit", "pattern": "attribute_threshold",
                 "description": "Expense amount exceeds policy without escalation."},
            ],
        },
        {
            "name": "HR Onboarding",
            "category": "hr",
            "description": "New hire onboarding from offer accepted through day-one readiness.",
            "expected_activities": [
                "Offer Accepted", "Background Check", "Provisioning Requested",
                "Access Granted", "Equipment Shipped", "Orientation Scheduled", "Day One",
            ],
            "kpis": [
                {"name": "Time to Day One", "metric": "avg_cycle_time", "target": 240, "unit": "hours"},
            ],
            "anti_patterns": [
                {"name": "Late Access Grant", "pattern": "sla_violation",
                 "description": "Access not granted before Day One."},
            ],
        },
        {
            "name": "IT Incident Management (ITIL)",
            "category": "itsm",
            "description": "Classic ITIL incident lifecycle.",
            "expected_activities": [
                "Log Incident", "Categorize", "Prioritize", "Diagnose",
                "Resolve", "Close",
            ],
            "kpis": [
                {"name": "Mean Time to Resolve", "metric": "avg_cycle_time", "target": 8, "unit": "hours"},
                {"name": "First Call Resolution", "metric": "sla_compliance", "target": 70, "unit": "percent"},
            ],
            "anti_patterns": [
                {"name": "Reopened Incidents", "pattern": "repeated_activity",
                 "description": "Incident reopened after initial close."},
            ],
        },
        {
            "name": "Return Material Authorization (RMA)",
            "category": "supply_chain",
            "description": "Product return, inspection, and refund / replacement.",
            "expected_activities": [
                "RMA Requested", "RMA Approved", "Return Shipped",
                "Received", "Inspected", "Refund Issued",
            ],
            "kpis": [
                {"name": "Return-to-Refund Cycle", "metric": "avg_cycle_time", "target": 168, "unit": "hours"},
            ],
            "anti_patterns": [
                {"name": "Refund Without Inspection", "pattern": "wrong_order",
                 "activities": ["Refund Issued", "Inspected"]},
            ],
        },
        {
            "name": "Sales Opportunity (CRM)",
            "category": "sales",
            "description": "Lead → qualified → proposal → negotiation → closed-won/lost.",
            "expected_activities": [
                "Lead Captured", "Qualified", "Proposal Sent",
                "Negotiation", "Contract Signed", "Closed Won",
            ],
            "kpis": [
                {"name": "Sales Cycle", "metric": "avg_cycle_time", "target": 720, "unit": "hours"},
                {"name": "Win Rate", "metric": "sla_compliance", "target": 25, "unit": "percent"},
            ],
            "anti_patterns": [
                {"name": "Stalled Pipeline", "pattern": "long_wait_time",
                 "description": "Opportunity stuck in Negotiation > 14 days."},
            ],
        },
        {
            "name": "Customer Support Ticket",
            "category": "service",
            "description": "Support ticket from creation through resolution and CSAT.",
            "expected_activities": [
                "Ticket Created", "Assigned", "In Progress",
                "Escalated", "Resolved", "Closed",
            ],
            "kpis": [
                {"name": "First Response Time", "metric": "avg_cycle_time", "target": 1, "unit": "hours"},
                {"name": "Resolution Time", "metric": "avg_cycle_time", "target": 24, "unit": "hours"},
            ],
            "anti_patterns": [
                {"name": "Escalation Loop", "pattern": "repeated_activity", "description": "Ticket escalated more than twice."},
            ],
        },
        {
            "name": "Insurance Claims (Auto)",
            "category": "insurance",
            "description": "Auto insurance claim from first notice of loss through payout.",
            "expected_activities": [
                "FNOL Received", "Assigned Adjuster", "Inspection",
                "Coverage Verified", "Estimate", "Approval", "Payment",
            ],
            "kpis": [
                {"name": "FNOL-to-Payment", "metric": "avg_cycle_time", "target": 336, "unit": "hours"},
                {"name": "Cycle-Time Compliance", "metric": "sla_compliance", "target": 90, "unit": "percent"},
            ],
            "anti_patterns": [
                {"name": "Payment Before Coverage Verification", "pattern": "wrong_order",
                 "activities": ["Payment", "Coverage Verified"]},
            ],
        },
        {
            "name": "Mortgage Processing",
            "category": "banking",
            "description": "Mortgage application through closing and disbursement.",
            "expected_activities": [
                "Application", "Document Collection", "Appraisal",
                "Underwriting", "Conditional Approval", "Closing", "Disbursement",
            ],
            "kpis": [
                {"name": "Application-to-Closing", "metric": "avg_cycle_time", "target": 1080, "unit": "hours"},
            ],
            "anti_patterns": [
                {"name": "Missing Appraisal", "pattern": "missing_activity", "activity": "Appraisal"},
            ],
        },
        {
            "name": "Clinical Trial Enrollment",
            "category": "healthcare",
            "description": "Patient enrollment into a clinical trial with consent workflow.",
            "expected_activities": [
                "Screening", "Consent Obtained", "Eligibility Verified",
                "Randomized", "First Visit",
            ],
            "kpis": [
                {"name": "Screening-to-Randomization", "metric": "avg_cycle_time", "target": 168, "unit": "hours"},
            ],
            "anti_patterns": [
                {"name": "Randomization Without Consent", "pattern": "wrong_order",
                 "activities": ["Randomized", "Consent Obtained"]},
            ],
        },
    ]

    created_count = 0
    skipped_count = 0

    for tmpl_data in builtin_templates:
        # Check if template already exists by name
        existing = await db.execute(
            select(ProcessTemplate).where(ProcessTemplate.name == tmpl_data["name"])
        )
        if existing.scalar_one_or_none() is not None:
            skipped_count += 1
            continue

        template = ProcessTemplate(
            name=tmpl_data["name"],
            category=tmpl_data["category"],
            description=tmpl_data.get("description"),
            reference_model=tmpl_data.get("reference_model", {}),
            expected_activities=tmpl_data["expected_activities"],
            kpis=tmpl_data["kpis"],
            anti_patterns=tmpl_data["anti_patterns"],
            is_builtin=True,
        )
        db.add(template)
        created_count += 1

    await db.commit()

    return {
        "detail": "Template seeding complete",
        "created": created_count,
        "skipped": skipped_count,
        "total": len(builtin_templates),
    }


class InstallFromUrlRequest(BaseModel):
    url: str = Field(..., description="HTTPS URL to a JSON manifest")


@router.post("/install-from-url", status_code=status.HTTP_201_CREATED)
async def install_template_from_url(
    body: InstallFromUrlRequest,
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """Fetch a process-template manifest from an HTTPS URL and install
    it into the local library.

    This is the lightweight "marketplace" flow — a distributed,
    GitHub-backed marketplace instead of a centralized one. The manifest
    must be a JSON document with the same shape as the builtin_templates
    entries: {name, category, description, expected_activities, kpis,
    anti_patterns}. URLs are restricted to https:// to avoid local-file
    or insecure-http fetches.
    """
    import httpx

    if not body.url.startswith("https://"):
        raise HTTPException(status_code=400, detail="Only https:// URLs are allowed")

    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(body.url)
            resp.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch manifest: {e}")

    try:
        manifest = resp.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="Manifest is not valid JSON")

    # Accept either a single template object or a list
    entries = manifest if isinstance(manifest, list) else [manifest]

    created = 0
    for entry in entries:
        name = entry.get("name")
        if not name:
            continue
        existing = await db.execute(select(ProcessTemplate).where(ProcessTemplate.name == name))
        if existing.scalar_one_or_none():
            continue
        template = ProcessTemplate(
            name=name,
            category=entry.get("category", "community"),
            description=entry.get("description"),
            reference_model=entry.get("reference_model", {}),
            expected_activities=entry.get("expected_activities", []),
            kpis=entry.get("kpis", []),
            anti_patterns=entry.get("anti_patterns", []),
            is_builtin=False,
        )
        db.add(template)
        created += 1

    await db.commit()
    return {"installed": created, "skipped": len(entries) - created, "url": body.url}
