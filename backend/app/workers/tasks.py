"""
Celery tasks for background processing of event logs, statistics computation,
alert evaluation, and connector syncing.

All tasks use synchronous SQLAlchemy sessions since Celery workers do not
natively support async event loops.
"""

import asyncio
import logging
import os
import uuid
from datetime import datetime, timezone

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.workers.celery_app import celery_app

logger = logging.getLogger(__name__)

# Build a synchronous database URL from the async one.
# Replace asyncpg with psycopg2 if the SYNC_DATABASE_URL is not explicitly set.
_sync_url = settings.SYNC_DATABASE_URL
if not _sync_url or "asyncpg" in _sync_url:
    _sync_url = settings.DATABASE_URL.replace(
        "postgresql+asyncpg", "postgresql+psycopg2"
    ).replace("postgresql+aiopg", "postgresql+psycopg2")

_sync_engine = create_engine(_sync_url, pool_pre_ping=True, pool_size=5, max_overflow=5)
SyncSession = sessionmaker(bind=_sync_engine, expire_on_commit=False)


def _get_sync_session() -> Session:
    """Create a new synchronous database session."""
    return SyncSession()


def _run_async(coro):
    """Run an async coroutine synchronously for use inside Celery tasks.

    Celery workers run in sync mode; several of our services (especially
    the connector adapters) were originally written as ``async def`` for
    FastAPI. Rather than rewriting every connector to have a sync path,
    we spin up a dedicated event loop per task invocation and drive the
    coroutine on it.

    Rules:
      - NEVER ``asyncio.get_event_loop()`` inside a Celery worker — that
        returns the default loop which we don't own.
      - ALWAYS ``asyncio.new_event_loop()`` + ``set_event_loop(None)`` so
        we don't leave a loop attached to the thread.
      - Use a try/finally to close the loop even on error.

    The old implementation used ``asyncio.get_event_loop`` which emits a
    ``DeprecationWarning`` on 3.12+ and occasionally reused a loop that
    had already been closed by a previous task.
    """
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        try:
            # Cancel any pending tasks (e.g. background tasks spawned by
            # the coroutine that didn't finish) before closing the loop.
            pending = asyncio.all_tasks(loop)
            for task in pending:
                task.cancel()
            if pending:
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
        except Exception:
            pass
        loop.close()
        asyncio.set_event_loop(None)


@celery_app.task(bind=True, name="app.workers.tasks.process_uploaded_file", max_retries=3)
def process_uploaded_file(self, event_log_id: str, file_path: str):
    """
    Process an uploaded event log file: detect format, load preview data,
    and update the EventLog record with column information and status.

    Args:
        event_log_id: UUID string of the EventLog record.
        file_path: Path to the uploaded file on disk.
    """
    from app.models import EventLog, EventLogStatus
    from app.services.ingestion import IngestionService

    session = _get_sync_session()
    ingestion = IngestionService()

    try:
        # Fetch the event log record
        event_log = session.get(EventLog, uuid.UUID(event_log_id))
        if event_log is None:
            logger.error(f"EventLog {event_log_id} not found in database")
            return {"status": "error", "message": "Event log not found"}

        if not os.path.exists(file_path):
            event_log.status = EventLogStatus.error
            event_log.error_message = f"File not found: {file_path}"
            session.commit()
            return {"status": "error", "message": "File not found"}

        # Process the upload (async method, run synchronously)
        preview = _run_async(
            ingestion.process_upload(file_path, event_log.name)
        )

        # Update the event log with preview data
        event_log.total_events = preview.get("total_rows", 0)
        event_log.status = EventLogStatus.ready
        event_log.error_message = None

        session.commit()

        logger.info(
            f"Successfully processed event log {event_log_id}: "
            f"{preview.get('total_rows', 0)} rows, "
            f"{len(preview.get('columns', []))} columns"
        )

        return {
            "status": "ready",
            "event_log_id": event_log_id,
            "total_rows": preview.get("total_rows", 0),
            "columns": preview.get("columns", []),
        }

    except Exception as e:
        logger.error(
            f"Error processing event log {event_log_id}: {e}", exc_info=True
        )

        # Update status to error
        try:
            event_log = session.get(EventLog, uuid.UUID(event_log_id))
            if event_log is not None:
                event_log.status = EventLogStatus.error
                event_log.error_message = str(e)[:500]
                session.commit()
        except Exception:
            session.rollback()

        # Retry with exponential backoff
        try:
            self.retry(exc=e, countdown=2 ** self.request.retries * 10)
        except self.MaxRetriesExceededError:
            return {"status": "error", "message": str(e)}

    finally:
        session.close()


@celery_app.task(bind=True, name="app.workers.tasks.compute_event_log_stats", max_retries=2)
def compute_event_log_stats(self, event_log_id: str):
    """
    Load an event log with its column mapping and compute basic statistics
    (total cases, total events, total activities, activities list).

    Args:
        event_log_id: UUID string of the EventLog record.
    """
    from app.models import EventLog
    from app.services.ingestion import IngestionService

    session = _get_sync_session()
    ingestion = IngestionService()

    try:
        event_log = session.get(EventLog, uuid.UUID(event_log_id))
        if event_log is None:
            logger.error(f"EventLog {event_log_id} not found")
            return {"status": "error", "message": "Event log not found"}

        if not event_log.case_id_column:
            logger.warning(
                f"EventLog {event_log_id} has no column mapping set, skipping stats"
            )
            return {"status": "skipped", "message": "No column mapping set"}

        if not event_log.file_path or not os.path.exists(event_log.file_path):
            logger.error(f"File not found for EventLog {event_log_id}")
            return {"status": "error", "message": "File not found"}

        mapping = {
            "case_id_column": event_log.case_id_column,
            "activity_column": event_log.activity_column,
            "timestamp_column": event_log.timestamp_column,
            "resource_column": event_log.resource_column,
            "cost_column": event_log.cost_column,
        }

        stats = _run_async(
            ingestion.apply_column_mapping(event_log.file_path, mapping)
        )

        event_log.total_cases = stats["total_cases"]
        event_log.total_events = stats["total_events"]
        event_log.total_activities = stats["total_activities"]
        event_log.activities_list = stats["activities_list"]

        session.commit()

        logger.info(
            f"Computed stats for EventLog {event_log_id}: "
            f"{stats['total_cases']} cases, {stats['total_events']} events, "
            f"{stats['total_activities']} activities"
        )

        return {"status": "success", "event_log_id": event_log_id, **stats}

    except Exception as e:
        logger.error(
            f"Error computing stats for EventLog {event_log_id}: {e}",
            exc_info=True,
        )
        session.rollback()

        try:
            self.retry(exc=e, countdown=2 ** self.request.retries * 15)
        except self.MaxRetriesExceededError:
            return {"status": "error", "message": str(e)}

    finally:
        session.close()


@celery_app.task(name="app.workers.tasks.evaluate_alerts")
def evaluate_alerts(project_id: str):
    """
    Load all active alerts for a project, evaluate each one against its
    associated event log, send notifications for triggered alerts, and
    update the alert record.

    Args:
        project_id: UUID string of the Project.
    """
    from app.models import Alert, EventLog
    from app.services.alert_evaluator import AlertEvaluator
    from app.services.infra.notifier import Notifier
    from app.services.mining_engine import mining_engine

    session = _get_sync_session()
    evaluator = AlertEvaluator()
    notifier = Notifier()

    try:
        # Load all active alerts for this project
        result = session.execute(
            select(Alert).where(
                Alert.project_id == uuid.UUID(project_id),
                Alert.is_active == True,
            )
        )
        alerts = result.scalars().all()

        if not alerts:
            logger.info(f"No active alerts for project {project_id}")
            return {"status": "success", "evaluated": 0, "triggered": 0}

        evaluated = 0
        triggered = 0

        for alert in alerts:
            try:
                # Load associated event log
                event_log = session.get(EventLog, alert.event_log_id)
                if event_log is None:
                    logger.warning(
                        f"Event log {alert.event_log_id} not found for alert {alert.id}"
                    )
                    continue

                if not event_log.case_id_column or not event_log.file_path:
                    logger.warning(
                        f"Event log {alert.event_log_id} missing column mapping or file"
                    )
                    continue

                if not os.path.exists(event_log.file_path):
                    logger.warning(f"File not found: {event_log.file_path}")
                    continue

                df = mining_engine.load_event_log(
                    file_path=event_log.file_path,
                    case_id_col=event_log.case_id_column,
                    activity_col=event_log.activity_column,
                    timestamp_col=event_log.timestamp_column,
                    resource_col=event_log.resource_column,
                    cost_col=event_log.cost_column,
                )

                evaluation = evaluator.evaluate(alert, df)

                alert.last_value = evaluation["current_value"]
                evaluated += 1

                if evaluation["triggered"]:
                    alert.last_triggered = datetime.now(timezone.utc)
                    triggered += 1
                    logger.info(
                        f"Alert '{alert.name}' (ID: {alert.id}) TRIGGERED: "
                        f"metric={alert.metric}, value={evaluation['current_value']}, "
                        f"threshold={alert.threshold}"
                    )
                    notifier.send(alert, evaluation)
                else:
                    logger.debug(
                        f"Alert '{alert.name}' (ID: {alert.id}) OK: "
                        f"metric={alert.metric}, value={evaluation['current_value']}"
                    )

            except Exception as e:
                logger.error(
                    f"Error evaluating alert {alert.id}: {e}", exc_info=True
                )
                continue

        session.commit()

        logger.info(
            f"Alert evaluation for project {project_id}: "
            f"{evaluated} evaluated, {triggered} triggered"
        )

        return {
            "status": "success",
            "project_id": project_id,
            "evaluated": evaluated,
            "triggered": triggered,
        }

    except Exception as e:
        logger.error(
            f"Error evaluating alerts for project {project_id}: {e}",
            exc_info=True,
        )
        session.rollback()
        return {"status": "error", "message": str(e)}

    finally:
        session.close()


@celery_app.task(bind=True, name="app.workers.tasks.sync_connector", max_retries=2)
def sync_connector(self, connector_id: str):
    """
    Load a connector's configuration, fetch data using the appropriate
    connector service, and create or update the associated EventLog.

    Args:
        connector_id: UUID string of the Connector record.
    """
    from app.models import Connector, ConnectorStatus, EventLog, EventLogStatus, SourceType
    from app.services.connectors import get_connector_class

    session = _get_sync_session()

    try:
        connector = session.get(Connector, uuid.UUID(connector_id))
        if connector is None:
            logger.error(f"Connector {connector_id} not found")
            return {"status": "error", "message": "Connector not found"}

        # Dispatch via the connector registry — the SAME path the API uses, so
        # the scheduled (cron) and manual sync can never diverge on which types
        # are supported. (Previously this had its own if/elif that omitted
        # jira/github/odoo/zendesk/api_endpoint, silently erroring those on
        # their schedule.) Enterprise client libs stay lazily imported inside
        # the connector methods, so constructing here never needs them.
        cls = get_connector_class(connector.connector_type.value)
        if cls is None:
            connector.status = ConnectorStatus.error
            connector.error_message = f"Unsupported connector type: {connector.connector_type}"
            session.commit()
            return {"status": "error", "message": connector.error_message}
        service = cls()

        # Incremental sync: pass the last successful sync timestamp down to
        # the connector service so it can query only new/changed rows.
        # Credentials are encrypted at rest — decrypt in-memory right before
        # handing them to the service (never write the plaintext back).
        from app.services.infra.secret_box import decrypt_connector_config

        decrypted_config = decrypt_connector_config(connector.config)
        since = connector.last_sync
        try:
            file_path = _run_async(
                service.fetch_data(
                    config=decrypted_config,
                    column_mapping=connector.column_mapping,
                    since=since,
                )
            )
        except TypeError:
            # Connector service predates the ``since`` parameter — fall
            # back to a full fetch.
            file_path = _run_async(
                service.fetch_data(
                    config=decrypted_config,
                    column_mapping=connector.column_mapping,
                )
            )

        # Create EventLog record
        event_log = EventLog(
            project_id=connector.project_id,
            name=f"Sync: {connector.name} ({datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M')})",
            file_path=file_path,
            source_type=SourceType.connector,
            status=EventLogStatus.ready,
        )

        # Apply column mapping if available
        col_map = connector.column_mapping
        if col_map:
            event_log.case_id_column = col_map.get("case_id_column")
            event_log.activity_column = col_map.get("activity_column")
            event_log.timestamp_column = col_map.get("timestamp_column")
            event_log.resource_column = col_map.get("resource_column")
            event_log.cost_column = col_map.get("cost_column")

        session.add(event_log)

        # Update connector status
        connector.status = ConnectorStatus.active
        connector.last_sync = datetime.now(timezone.utc)
        connector.error_message = None

        session.commit()

        logger.info(
            f"Connector {connector_id} synced successfully. "
            f"Created EventLog {event_log.id}, file: {file_path}"
        )

        # If column mapping is set, trigger stats computation
        if event_log.case_id_column:
            compute_event_log_stats.delay(str(event_log.id))

        return {
            "status": "success",
            "connector_id": connector_id,
            "event_log_id": str(event_log.id),
            "file_path": file_path,
        }

    except Exception as e:
        logger.error(
            f"Error syncing connector {connector_id}: {e}", exc_info=True
        )

        try:
            connector = session.get(Connector, uuid.UUID(connector_id))
            if connector is not None:
                connector.status = ConnectorStatus.error
                connector.error_message = str(e)[:500]
                session.commit()
        except Exception:
            session.rollback()

        try:
            self.retry(exc=e, countdown=2 ** self.request.retries * 30)
        except self.MaxRetriesExceededError:
            return {"status": "error", "message": str(e)}

    finally:
        session.close()


@celery_app.task(name="app.workers.tasks.scheduled_alert_check")
def scheduled_alert_check():
    """
    Periodic task that loads all active alerts across all projects and
    evaluates each one. This is intended to be run on a schedule
    (e.g., every 15 minutes via Celery Beat).
    """
    from app.models import Alert, Project

    session = _get_sync_session()

    try:
        # Get all distinct project IDs that have active alerts
        result = session.execute(
            select(Alert.project_id).where(Alert.is_active == True).distinct()
        )
        project_ids = [row[0] for row in result.all()]

        if not project_ids:
            logger.info("No projects with active alerts found")
            return {"status": "success", "projects_checked": 0}

        logger.info(f"Running scheduled alert check for {len(project_ids)} projects")

        for project_id in project_ids:
            try:
                evaluate_alerts.delay(str(project_id))
            except Exception as e:
                logger.error(
                    f"Error dispatching alert evaluation for project {project_id}: {e}"
                )

        return {
            "status": "success",
            "projects_checked": len(project_ids),
        }

    except Exception as e:
        logger.error(f"Error in scheduled alert check: {e}", exc_info=True)
        return {"status": "error", "message": str(e)}

    finally:
        session.close()


@celery_app.task(name="app.workers.tasks.send_scheduled_report")
def send_scheduled_report(report_id: str):
    """Generate and email a scheduled report for a single ScheduledReport record."""
    from app.models import ScheduledReport, EventLog
    from app.services.mining_engine import mining_engine
    import smtplib
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText
    from app.config import settings

    session = _get_sync_session()
    try:
        report = session.get(ScheduledReport, uuid.UUID(report_id))
        if not report or not report.is_active:
            return {"status": "skipped", "reason": "inactive or not found"}

        event_log = session.get(EventLog, report.event_log_id)
        if not event_log or not event_log.file_path or not event_log.case_id_column:
            return {"status": "skipped", "reason": "event log not ready"}

        df = mining_engine.load_event_log(
            file_path=event_log.file_path,
            case_id_col=event_log.case_id_column,
            activity_col=event_log.activity_column,
            timestamp_col=event_log.timestamp_column,
            resource_col=event_log.resource_column,
            cost_col=event_log.cost_column,
        )

        report_result = mining_engine.generate_report(df)
        html_content = report_result.get("html", "<p>Report generation failed.</p>")

        recipients = report.email_recipients or []
        if not recipients:
            return {"status": "skipped", "reason": "no recipients"}

        msg = MIMEMultipart()
        msg["Subject"] = f"[FlowMiner] Scheduled Report: {report.name}"
        msg["From"] = getattr(settings, "SMTP_FROM", "reports@flowminer.io")
        msg["To"] = ", ".join(recipients)
        msg.attach(MIMEText(html_content, "html"))

        smtp_host = getattr(settings, "SMTP_HOST", "localhost")
        smtp_port = int(getattr(settings, "SMTP_PORT", 587))
        smtp_user = getattr(settings, "SMTP_USER", "")
        smtp_pass = getattr(settings, "SMTP_PASS", "")

        # Dev fallback: if SMTP isn't configured, write the rendered email
        # to /data/uploads/_outbox/<report_id>.eml instead of sending.
        # This lets contributors verify the scheduled-report pipeline
        # end-to-end without a real mail server.
        if smtp_host in ("", "localhost") and not smtp_user:
            outbox_dir = os.path.join(settings.UPLOAD_DIR, "_outbox")
            os.makedirs(outbox_dir, exist_ok=True)
            outbox_path = os.path.join(outbox_dir, f"{report_id}_{int(datetime.now(timezone.utc).timestamp())}.eml")
            with open(outbox_path, "wb") as fh:
                fh.write(msg.as_bytes())
            logger.info("SMTP not configured — wrote scheduled report to %s", outbox_path)
        else:
            with smtplib.SMTP(smtp_host, smtp_port, timeout=30) as server:
                if smtp_user and smtp_pass:
                    server.starttls()
                    server.login(smtp_user, smtp_pass)
                server.send_message(msg)

        report.last_sent_at = datetime.now(timezone.utc)
        report.send_count = (report.send_count or 0) + 1
        session.commit()

        logger.info(f"Scheduled report {report_id} sent to {recipients}")
        return {"status": "sent", "recipients": recipients}

    except Exception as e:
        logger.error(f"Scheduled report {report_id} failed: {e}", exc_info=True)
        return {"status": "error", "message": str(e)}
    finally:
        session.close()


@celery_app.task(name="app.workers.tasks.dispatch_scheduled_reports")
def dispatch_scheduled_reports():
    """Periodic task: check all active scheduled reports and dispatch any that are due."""
    from app.models import ScheduledReport

    session = _get_sync_session()
    try:
        result = session.execute(
            select(ScheduledReport).where(ScheduledReport.is_active == True)
        )
        reports = result.scalars().all()
        dispatched = 0

        now = datetime.now(timezone.utc)
        for report in reports:
            last = report.last_sent_at
            freq = report.frequency.value if hasattr(report.frequency, 'value') else str(report.frequency)

            should_send = False
            if last is None:
                should_send = True
            elif freq == "daily" and (now - last).total_seconds() >= 86400:
                should_send = True
            elif freq == "weekly" and (now - last).total_seconds() >= 604800:
                should_send = True
            elif freq == "monthly" and (now - last).total_seconds() >= 2592000:
                should_send = True

            if should_send:
                send_scheduled_report.delay(str(report.id))
                dispatched += 1

        return {"status": "success", "dispatched": dispatched}
    except Exception as e:
        logger.error(f"dispatch_scheduled_reports failed: {e}", exc_info=True)
        return {"status": "error", "message": str(e)}
    finally:
        session.close()


@celery_app.task(name="app.workers.tasks.evaluate_all_alerts")
def evaluate_all_alerts():
    """Periodic task: evaluate every active alert across every project and
    fire notifications on any that trip. Uses the existing per-project
    evaluate_alerts task so each project's evaluation is isolated."""
    from app.models import Project

    session = _get_sync_session()
    try:
        projects = session.execute(select(Project)).scalars().all()
        fanned = 0
        for project in projects:
            evaluate_alerts.delay(str(project.id))
            fanned += 1
        return {"status": "success", "projects_fanned_out": fanned}
    except Exception as e:
        logger.error(f"evaluate_all_alerts failed: {e}", exc_info=True)
        return {"status": "error", "message": str(e)}
    finally:
        session.close()


@celery_app.task(name="app.workers.tasks.stream_audit_to_siem")
def stream_audit_to_siem():
    """Push new audit rows to a SIEM HEC. Set SIEM_HEC_URL to enable.

    Uses a Redis cursor so restarts don't re-ship events.
    """
    import json as _json
    import os as _os
    import httpx as _httpx

    url = _os.getenv("SIEM_HEC_URL", "").strip()
    if not url:
        return {"status": "skipped", "reason": "SIEM_HEC_URL not set"}

    from app.models import AuditLog
    from sqlalchemy import desc

    session = _get_sync_session()
    try:
        import redis as _redis
        try:
            rc = _redis.from_url(settings.REDIS_URL, decode_responses=True)
            last_id = rc.get("flowminer:siem:last_id")
        except Exception:
            rc = None
            last_id = None

        rows = session.execute(
            select(AuditLog).order_by(desc(AuditLog.created_at)).limit(500)
        ).scalars().all()

        ship = []
        for r in rows:
            if last_id and str(r.id) == last_id:
                break
            ship.append(r)
        if not ship:
            return {"status": "ok", "shipped": 0}

        payload = "\n".join(
            _json.dumps(
                {
                    "event": {
                        "id": str(r.id),
                        "user_id": str(r.user_id) if r.user_id else None,
                        "user_email": r.user_email,
                        "ip_address": r.ip_address,
                        "method": r.method,
                        "path": r.path,
                        "status_code": r.status_code,
                        "resource_type": r.resource_type,
                        "resource_id": r.resource_id,
                        "action": r.action,
                        "created_at": r.created_at.isoformat() if r.created_at else None,
                    },
                    "source": "flowminer",
                },
                default=str,
            )
            for r in ship
        )

        headers = {"Content-Type": "application/x-ndjson"}
        token = _os.getenv("SIEM_HEC_TOKEN", "").strip()
        if token:
            headers["Authorization"] = f"Splunk {token}"

        try:
            with _httpx.Client(timeout=15) as client:
                resp = client.post(url, content=payload, headers=headers)
                resp.raise_for_status()
        except Exception as e:
            logger.warning("SIEM shipment failed: %s", e)
            return {"status": "error", "message": str(e)}

        if rc is not None:
            try:
                rc.set("flowminer:siem:last_id", str(ship[0].id))
            except Exception:
                pass

        return {"status": "ok", "shipped": len(ship)}
    finally:
        session.close()


@celery_app.task(name="app.workers.tasks.check_anomaly_subscriptions")
def check_anomaly_subscriptions():
    """Walk active alerts whose description is tagged ``streaming_anomaly``
    and fire them when conformance fitness drops below threshold.
    """
    session = _get_sync_session()
    try:
        from app.models import Alert, AlertCondition, EventLog, EventLogStatus
        from app.services.mining_engine import mining_engine
        from sqlalchemy import select

        alerts = session.execute(
            select(Alert)
            .where(Alert.condition == AlertCondition.custom, Alert.is_active == True)  # noqa: E712
        ).scalars().all()

        fired = 0
        for alert in alerts:
            if "streaming_anomaly" not in (alert.description or ""):
                continue
            try:
                log = session.execute(
                    select(EventLog)
                    .where(EventLog.project_id == alert.project_id, EventLog.status == EventLogStatus.ready)
                    .order_by(EventLog.created_at.desc())
                ).scalars().first()
                if not log or not log.file_path or not os.path.exists(log.file_path):
                    continue
                df = mining_engine.load_event_log(
                    file_path=log.file_path,
                    case_id_col=log.case_id_column,
                    activity_col=log.activity_column,
                    timestamp_col=log.timestamp_column,
                    resource_col=log.resource_column,
                    cost_col=log.cost_column,
                )
                result = mining_engine.run_conformance(df)
                fitness = float(result.get("fitness", 0))
                threshold = float(getattr(alert, "threshold_value", None) or 0.85)
                if fitness < threshold:
                    alert.last_triggered_at = datetime.now(timezone.utc)
                    fired += 1
            except Exception as e:
                logger.warning("anomaly check failed for alert %s: %s", alert.id, e)
                continue
        session.commit()
        return {"status": "ok", "fired": fired}
    finally:
        session.close()


@celery_app.task(name="app.workers.tasks.backup_database")
def backup_database():
    """Nightly pg_dump → /data/uploads/_backups/flowminer-YYYYMMDD.sql.

    Retains the last 7 backups. Production deployments should mount
    /data/uploads/_backups to an external volume (S3, NFS, etc.) so the
    backup survives a container crash.
    """
    import subprocess

    from urllib.parse import urlparse

    backup_dir = os.path.join(settings.UPLOAD_DIR, "_backups")
    os.makedirs(backup_dir, exist_ok=True)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    target = os.path.join(backup_dir, f"flowminer-{stamp}.sql.gz")

    url = urlparse(_sync_url.replace("postgresql+psycopg2://", "postgresql://"))
    env = os.environ.copy()
    if url.password:
        env["PGPASSWORD"] = url.password

    cmd = [
        "pg_dump",
        "-h", url.hostname or "db",
        "-p", str(url.port or 5432),
        "-U", url.username or "flowminer",
        "-d", (url.path or "/flowminer").lstrip("/"),
        "--no-owner",
        "--no-acl",
    ]

    try:
        with open(target + ".raw", "wb") as out:
            proc = subprocess.run(cmd, stdout=out, stderr=subprocess.PIPE, env=env, timeout=600)
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.decode("utf-8", errors="replace"))

        # gzip in-place
        import gzip
        import shutil

        with open(target + ".raw", "rb") as src, gzip.open(target, "wb") as dst:
            shutil.copyfileobj(src, dst)
        os.remove(target + ".raw")
    except FileNotFoundError:
        logger.warning("pg_dump not available in worker image — skipping backup")
        return {"status": "skipped", "reason": "pg_dump not installed"}
    except Exception as e:
        logger.error("Backup failed: %s", e, exc_info=True)
        # Clean up partial files
        for suffix in ("", ".raw"):
            p = target + suffix
            if os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass
        return {"status": "error", "message": str(e)}

    # Retain only the last 7 backups
    try:
        backups = sorted(
            [f for f in os.listdir(backup_dir) if f.endswith(".sql.gz")],
            reverse=True,
        )
        for old in backups[7:]:
            try:
                os.remove(os.path.join(backup_dir, old))
            except OSError:
                pass
    except OSError:
        pass

    return {"status": "ok", "path": target, "size_bytes": os.path.getsize(target)}


@celery_app.task(name="app.workers.tasks.check_conformance_drift")
def check_conformance_drift():
    """Nightly job: for every ready event log with mapping, run conformance
    and emit an Alert if the fitness score dropped notably compared to the
    previous run. Fitness history is stored in Redis for simplicity —
    eventually this should live in a proper table.
    """
    import json
    import redis as _redis

    from app.models import Alert, AlertCondition, EventLog, EventLogStatus, NotificationChannel
    from app.services.mining_engine import mining_engine

    try:
        rc = _redis.from_url(settings.REDIS_URL, decode_responses=True)
    except Exception as e:
        logger.warning("conformance-drift: Redis unreachable (%s), skipping", e)
        return {"status": "skipped"}

    session = _get_sync_session()
    try:
        logs = session.execute(
            select(EventLog).where(
                EventLog.status == EventLogStatus.ready,
                EventLog.case_id_column.is_not(None),
                EventLog.hidden == False,  # noqa: E712
            )
        ).scalars().all()

        checked = 0
        drifts = 0
        for event_log in logs:
            if not event_log.file_path or not os.path.exists(event_log.file_path):
                continue
            try:
                df = mining_engine.load_event_log(
                    file_path=event_log.file_path,
                    case_id_col=event_log.case_id_column,
                    activity_col=event_log.activity_column,
                    timestamp_col=event_log.timestamp_column,
                    resource_col=event_log.resource_column,
                    cost_col=event_log.cost_column,
                )
                result = mining_engine.run_conformance(df)
                fitness = float(result.get("fitness", 0))
            except Exception as e:
                logger.warning("conformance check failed for %s: %s", event_log.id, e)
                continue

            checked += 1
            hist_key = f"flowminer:conformance_history:{event_log.id}"
            try:
                prev_raw = rc.get(hist_key)
                prev = json.loads(prev_raw) if prev_raw else None
            except Exception:
                prev = None

            if prev is not None and isinstance(prev, dict) and "fitness" in prev:
                drop = prev["fitness"] - fitness
                # Flag a drift if fitness falls by >5 percentage points
                if drop > 0.05:
                    drifts += 1
                    alert = Alert(
                        project_id=event_log.project_id,
                        name=f"Conformance drift on {event_log.name}",
                        description=(
                            f"Fitness dropped from {prev['fitness']:.2f} to {fitness:.2f} "
                            f"(−{drop:.2f}) since last nightly check."
                        ),
                        condition=AlertCondition.custom,
                        threshold_value=0.05,
                        notification_channel=NotificationChannel.in_app,
                        is_active=True,
                        last_triggered_at=datetime.now(timezone.utc),
                    )
                    session.add(alert)

            try:
                rc.set(hist_key, json.dumps({"fitness": fitness, "checked_at": datetime.now(timezone.utc).isoformat()}))
            except Exception:
                pass

        session.commit()
        return {"status": "success", "checked": checked, "drifts": drifts}
    except Exception as e:
        logger.error(f"check_conformance_drift failed: {e}", exc_info=True)
        session.rollback()
        return {"status": "error", "message": str(e)}
    finally:
        session.close()


@celery_app.task(name="app.workers.tasks.reset_demo_data")
def reset_demo_data():
    """Hourly demo reset.

    Purges every project owned by the demo user and re-runs the seeder
    so the next visitor starts from a clean slate. No-op when
    ``settings.DEMO_MODE`` is off so the task is safe to register
    unconditionally in the beat schedule — on normal deployments it
    fires every hour and immediately returns.
    """
    if not settings.DEMO_MODE:
        return {"status": "skipped", "reason": "DEMO_MODE off"}

    from app.database import async_session
    from app.services.demo_seeder import reset_demo_data as _reset

    async def _inner():
        async with async_session() as session:
            await _reset(session)

    try:
        _run_async(_inner())
        return {"status": "reset"}
    except Exception as e:
        logger.exception("demo reset failed")
        return {"status": "error", "message": str(e)[:500]}
