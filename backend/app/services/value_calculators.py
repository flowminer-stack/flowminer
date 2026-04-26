"""Pre-built ROI value calculators.

Each calculator is a formula that takes a small set of user-supplied
inputs (volume, cost per unit, FTE cost, etc.) plus the computed
baseline/current values and returns an estimated annual savings figure.

Celonis ships these as first-class "value calculators" in their
Transformation Hub. We offer the same for the most common P2P / O2C /
service-management use cases.

Each calculator is a dict with:
  - id: stable identifier
  - name: display name
  - category: P2P / O2C / ITSM / HR / finance / general
  - description: 1-2 sentences
  - inputs: list of {key, label, unit, default} for the user form
  - formula: Python string evaluated with safe_eval against the inputs
             AND `baseline` / `target` / `current` variables from the
             Initiative.

Formulas are deliberately simple so they can be shown to the user and
overridden. The API exposes the whole library for the frontend
form to populate.
"""

from __future__ import annotations

VALUE_CALCULATORS: list[dict] = [
    # ── P2P / Accounts Payable ────────────────────────────────────────
    {
        "id": "p2p_manual_payment",
        "name": "Reduce manual payment effort",
        "category": "P2P",
        "description": "Savings from reducing manual intervention on invoice payments.",
        "inputs": [
            {"key": "invoices_per_year", "label": "Invoices per year", "unit": "#", "default": 100000},
            {"key": "manual_minutes", "label": "Manual review minutes per invoice", "unit": "min", "default": 8},
            {"key": "fte_cost_per_hour", "label": "Fully-loaded FTE cost", "unit": "$/hr", "default": 45},
        ],
        "formula": "(invoices_per_year * (baseline - current) / 100) * (manual_minutes / 60) * fte_cost_per_hour",
    },
    {
        "id": "p2p_duplicate_payments",
        "name": "Eliminate duplicate payments",
        "category": "P2P",
        "description": "Savings from catching duplicate invoice payments before they're issued.",
        "inputs": [
            {"key": "annual_spend", "label": "Annual AP spend", "unit": "$", "default": 100000000},
            {"key": "dup_rate_pct", "label": "Duplicate payment rate (before)", "unit": "%", "default": 0.5},
        ],
        "formula": "annual_spend * (dup_rate_pct / 100) * (1 - (current / baseline))",
    },
    {
        "id": "p2p_early_payment_discount",
        "name": "Capture early-payment discounts",
        "category": "P2P",
        "description": "Savings from paying invoices within the early-payment discount window.",
        "inputs": [
            {"key": "annual_spend", "label": "Annual AP spend", "unit": "$", "default": 100000000},
            {"key": "discount_pct", "label": "Typical discount", "unit": "%", "default": 2},
            {"key": "eligible_pct", "label": "Eligible invoices", "unit": "%", "default": 30},
        ],
        "formula": "annual_spend * (eligible_pct / 100) * (discount_pct / 100) * ((baseline - current) / 100)",
    },
    # ── O2C / Accounts Receivable ─────────────────────────────────────
    {
        "id": "o2c_dso_reduction",
        "name": "Reduce Days Sales Outstanding (DSO)",
        "category": "O2C",
        "description": "Working-capital savings from shortening the cash collection cycle.",
        "inputs": [
            {"key": "annual_revenue", "label": "Annual revenue", "unit": "$", "default": 500000000},
            {"key": "wacc_pct", "label": "Weighted average cost of capital", "unit": "%", "default": 8},
        ],
        "formula": "annual_revenue / 365 * (baseline - current) * (wacc_pct / 100)",
    },
    {
        "id": "o2c_order_rework",
        "name": "Reduce order rework",
        "category": "O2C",
        "description": "Savings from reducing the number of orders that need manual correction.",
        "inputs": [
            {"key": "orders_per_year", "label": "Orders per year", "unit": "#", "default": 250000},
            {"key": "rework_minutes", "label": "Rework minutes per order", "unit": "min", "default": 15},
            {"key": "fte_cost_per_hour", "label": "Fully-loaded FTE cost", "unit": "$/hr", "default": 50},
        ],
        "formula": "orders_per_year * (baseline - current) / 100 * (rework_minutes / 60) * fte_cost_per_hour",
    },
    {
        "id": "o2c_billing_blocks",
        "name": "Reduce billing blocks",
        "category": "O2C",
        "description": "Revenue recovered by resolving billing blocks faster.",
        "inputs": [
            {"key": "blocked_revenue_per_day", "label": "Blocked revenue / day", "unit": "$", "default": 100000},
            {"key": "wacc_pct", "label": "WACC", "unit": "%", "default": 8},
        ],
        "formula": "blocked_revenue_per_day * (baseline - current) * (wacc_pct / 100) / 100",
    },
    # ── IT Service Management ────────────────────────────────────────
    {
        "id": "itsm_mttr",
        "name": "Reduce Mean Time to Resolution",
        "category": "ITSM",
        "description": "Productivity gains from resolving incidents faster.",
        "inputs": [
            {"key": "incidents_per_year", "label": "Incidents per year", "unit": "#", "default": 50000},
            {"key": "cost_per_hour_down", "label": "Cost per hour of service degradation", "unit": "$/hr", "default": 500},
        ],
        "formula": "incidents_per_year * (baseline - current) / 3600 * cost_per_hour_down",
    },
    {
        "id": "itsm_fcr",
        "name": "Improve First Call Resolution",
        "category": "ITSM",
        "description": "Savings from resolving more incidents on the first interaction.",
        "inputs": [
            {"key": "incidents_per_year", "label": "Incidents per year", "unit": "#", "default": 50000},
            {"key": "escalation_cost", "label": "Cost of each escalation", "unit": "$", "default": 120},
        ],
        "formula": "incidents_per_year * (current - baseline) / 100 * escalation_cost",
    },
    {
        "id": "itsm_automation_coverage",
        "name": "Expand automation coverage",
        "category": "ITSM",
        "description": "FTE savings from automating repetitive request handling.",
        "inputs": [
            {"key": "requests_per_year", "label": "Requests per year", "unit": "#", "default": 100000},
            {"key": "minutes_saved_each", "label": "Minutes saved per automated request", "unit": "min", "default": 12},
            {"key": "fte_cost_per_hour", "label": "FTE cost", "unit": "$/hr", "default": 60},
        ],
        "formula": "requests_per_year * (current - baseline) / 100 * (minutes_saved_each / 60) * fte_cost_per_hour",
    },
    # ── HR / Employee onboarding ─────────────────────────────────────
    {
        "id": "hr_onboarding_cycle",
        "name": "Shorten onboarding cycle",
        "category": "HR",
        "description": "Productivity gains from new hires reaching full productivity sooner.",
        "inputs": [
            {"key": "hires_per_year", "label": "Hires per year", "unit": "#", "default": 500},
            {"key": "daily_contribution", "label": "Expected daily value per FTE", "unit": "$/day", "default": 400},
        ],
        "formula": "hires_per_year * (baseline - current) / 86400 * daily_contribution",
    },
    {
        "id": "hr_first_year_turnover",
        "name": "Reduce first-year turnover",
        "category": "HR",
        "description": "Savings from retaining more new hires past their first anniversary.",
        "inputs": [
            {"key": "hires_per_year", "label": "Hires per year", "unit": "#", "default": 500},
            {"key": "replacement_cost_per_hire", "label": "Replacement cost per hire", "unit": "$", "default": 30000},
        ],
        "formula": "hires_per_year * (baseline - current) / 100 * replacement_cost_per_hire",
    },
    # ── Finance / close ─────────────────────────────────────────────
    {
        "id": "finance_close_cycle",
        "name": "Shorten close cycle",
        "category": "finance",
        "description": "Savings from shortening the finance close by reducing manual reconciliation.",
        "inputs": [
            {"key": "closes_per_year", "label": "Closes per year", "unit": "#", "default": 12},
            {"key": "fte_hours_per_close", "label": "FTE hours spent per close", "unit": "hr", "default": 200},
            {"key": "fte_cost_per_hour", "label": "FTE cost", "unit": "$/hr", "default": 80},
        ],
        "formula": "closes_per_year * fte_hours_per_close * (baseline - current) / baseline * fte_cost_per_hour",
    },
    {
        "id": "finance_audit_prep",
        "name": "Reduce audit preparation effort",
        "category": "finance",
        "description": "Savings from automating evidence collection for compliance audits.",
        "inputs": [
            {"key": "audit_hours_before", "label": "Audit prep hours before", "unit": "hr", "default": 2000},
            {"key": "fte_cost_per_hour", "label": "FTE cost", "unit": "$/hr", "default": 80},
        ],
        "formula": "audit_hours_before * (baseline - current) / baseline * fte_cost_per_hour",
    },
    # ── Service / customer support ───────────────────────────────────
    {
        "id": "cs_handle_time",
        "name": "Reduce average handle time",
        "category": "service",
        "description": "Agent productivity gains from shorter handle time per ticket.",
        "inputs": [
            {"key": "tickets_per_year", "label": "Tickets per year", "unit": "#", "default": 200000},
            {"key": "fte_cost_per_hour", "label": "Agent cost", "unit": "$/hr", "default": 40},
        ],
        "formula": "tickets_per_year * (baseline - current) / 3600 * fte_cost_per_hour",
    },
    {
        "id": "cs_deflection",
        "name": "Increase self-service deflection",
        "category": "service",
        "description": "Savings from deflecting tickets to self-service before they reach an agent.",
        "inputs": [
            {"key": "tickets_per_year", "label": "Tickets per year", "unit": "#", "default": 200000},
            {"key": "cost_per_ticket", "label": "Cost per live ticket", "unit": "$", "default": 15},
        ],
        "formula": "tickets_per_year * (current - baseline) / 100 * cost_per_ticket",
    },
    # ── Manufacturing / ops ──────────────────────────────────────────
    {
        "id": "mfg_cycle_time",
        "name": "Reduce production cycle time",
        "category": "manufacturing",
        "description": "Capacity gains from shortening end-to-end production cycles.",
        "inputs": [
            {"key": "units_per_year", "label": "Units produced per year", "unit": "#", "default": 100000},
            {"key": "margin_per_unit", "label": "Gross margin per unit", "unit": "$", "default": 20},
        ],
        "formula": "units_per_year * (baseline - current) / baseline * margin_per_unit",
    },
    {
        "id": "mfg_scrap_rate",
        "name": "Reduce scrap rate",
        "category": "manufacturing",
        "description": "Material savings from lower scrap in the production line.",
        "inputs": [
            {"key": "annual_material_cost", "label": "Annual material cost", "unit": "$", "default": 10000000},
        ],
        "formula": "annual_material_cost * (baseline - current) / 100",
    },
    # ── General ──────────────────────────────────────────────────────
    {
        "id": "general_fte_reclaim",
        "name": "FTE hours reclaimed",
        "category": "general",
        "description": "Direct FTE cost saved when a repetitive task becomes faster.",
        "inputs": [
            {"key": "annual_volume", "label": "Annual volume", "unit": "#", "default": 10000},
            {"key": "fte_cost_per_hour", "label": "FTE cost", "unit": "$/hr", "default": 50},
        ],
        "formula": "annual_volume * (baseline - current) / 3600 * fte_cost_per_hour",
    },
    {
        "id": "general_compliance_fines",
        "name": "Avoided compliance fines",
        "category": "general",
        "description": "Expected savings from reducing the probability of a compliance breach.",
        "inputs": [
            {"key": "expected_fine_amount", "label": "Expected fine", "unit": "$", "default": 500000},
            {"key": "risk_pct_before", "label": "Breach probability before", "unit": "%", "default": 5},
        ],
        "formula": "expected_fine_amount * (risk_pct_before / 100) * (1 - (current / baseline))",
    },
    {
        "id": "general_customer_retention",
        "name": "Customer retention uplift",
        "category": "general",
        "description": "Revenue uplift from retaining customers who would otherwise churn.",
        "inputs": [
            {"key": "at_risk_customers", "label": "Customers at churn risk", "unit": "#", "default": 1000},
            {"key": "annual_revenue_per_customer", "label": "Annual revenue per customer", "unit": "$", "default": 5000},
        ],
        "formula": "at_risk_customers * (current - baseline) / 100 * annual_revenue_per_customer",
    },
]


def get_calculators() -> list[dict]:
    """Return every calculator in the library."""
    return VALUE_CALCULATORS


def get_calculator(calc_id: str) -> dict | None:
    """Look up a calculator by id."""
    for c in VALUE_CALCULATORS:
        if c["id"] == calc_id:
            return c
    return None
