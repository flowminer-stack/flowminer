"""
Celery application configuration for FlowMiner background task processing.
"""

from celery import Celery
from celery.schedules import crontab
from app.config import settings

celery_app = Celery(
    "flowminer",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL,
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    task_time_limit=3600,
    task_soft_time_limit=3000,
)

# ─── Celery Beat schedule ────────────────────────────────────────────────────
# Periodic jobs dispatched by the beat scheduler container. Each entry maps
# a schedule to a task name; actual work happens in app.workers.tasks.
celery_app.conf.beat_schedule = {
    "dispatch-scheduled-reports-every-5-min": {
        "task": "app.workers.tasks.dispatch_scheduled_reports",
        "schedule": 300.0,  # every 5 minutes
    },
    "evaluate-alerts-every-5-min": {
        "task": "app.workers.tasks.evaluate_all_alerts",
        "schedule": 300.0,
    },
    "conformance-drift-nightly": {
        "task": "app.workers.tasks.check_conformance_drift",
        "schedule": crontab(hour=2, minute=0),  # 02:00 UTC daily
    },
    "database-backup-daily": {
        "task": "app.workers.tasks.backup_database",
        "schedule": crontab(hour=3, minute=0),  # 03:00 UTC daily
    },
    "stream-audit-to-siem": {
        "task": "app.workers.tasks.stream_audit_to_siem",
        "schedule": 60.0,  # every minute — no-op if SIEM_HEC_URL not set
    },
    "anomaly-subscription-check": {
        "task": "app.workers.tasks.check_anomaly_subscriptions",
        "schedule": 300.0,
    },
    # Demo instance: wipe and re-seed every hour. The task itself
    # no-ops unless settings.DEMO_MODE is true, so this entry is safe
    # to ship on every deployment.
    "reset-demo-data-hourly": {
        "task": "app.workers.tasks.reset_demo_data",
        "schedule": crontab(minute=0),
    },
}

celery_app.autodiscover_tasks(["app.workers"])
