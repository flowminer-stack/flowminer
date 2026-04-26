"""
Notifier: delivers alert notifications via email, webhook, or Slack.
"""

import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import httpx

from app.services.url_guard import UnsafeUrlError, validate_public_url

logger = logging.getLogger(__name__)


def _safe_webhook_url(url: str | None, alert_id) -> str | None:
    """Run a user-supplied webhook URL through the SSRF guard. Returns
    the validated URL on success, ``None`` on failure (the caller logs
    and aborts delivery). This prevents an authenticated user from
    pointing a webhook at IMDS, internal Redis, or private RFC1918
    space via the alert config (security audit finding)."""
    if not url:
        return None
    try:
        return validate_public_url(url)
    except UnsafeUrlError as e:
        logger.error(
            "Refusing to deliver notification for alert %s: "
            "webhook URL failed SSRF validation: %s",
            alert_id, e,
        )
        return None


class Notifier:
    """Delivers alert notifications via email, webhook, or Slack."""

    def send(self, alert, evaluation_result: dict) -> None:
        """Route the notification to the appropriate channel.

        Args:
            alert:             Alert ORM instance.
            evaluation_result: Dict returned by AlertEvaluator.evaluate().
        """
        channel = (
            alert.notification_channel.value
            if hasattr(alert.notification_channel, "value")
            else str(alert.notification_channel)
        )

        if channel == "email":
            self._send_email(alert, evaluation_result)
        elif channel == "webhook":
            self._send_webhook(alert, evaluation_result)
        elif channel == "slack":
            self._send_slack(alert, evaluation_result)
        elif channel == "teams":
            self._send_teams(alert, evaluation_result)
        elif channel == "in_app":
            # In-app notifications are rendered from the alert table itself
            # when the frontend polls — no outbound send.
            pass
        else:
            logger.warning(
                "Alert %s has unknown notification channel: %s", alert.id, channel
            )

    # ------------------------------------------------------------------
    # Channel implementations
    # ------------------------------------------------------------------

    def _send_email(self, alert, result: dict) -> None:
        """Send an alert notification via SMTP."""
        from app.config import settings

        recipients = alert.email_recipients or []
        if not recipients:
            logger.warning("Alert %s has no email recipients configured", alert.id)
            return

        status_label = "TRIGGERED" if result["triggered"] else "OK"
        subject = f"[FlowMiner Alert] {alert.name} \u2014 {status_label}"

        body = (
            f"Alert: {alert.name}\n"
            f"Status: {status_label}\n"
            f"Metric: {alert.metric}\n"
            f"Current Value: {result['current_value']:.4f}\n"
            f"Condition: {alert.condition.value if hasattr(alert.condition, 'value') else alert.condition}"
            f" {alert.threshold}\n"
            f"Message: {result['message']}\n"
            f"\n\u2014 FlowMiner Process Mining Platform\n"
        )

        try:
            msg = MIMEMultipart()
            msg["Subject"] = subject
            msg["From"] = getattr(settings, "SMTP_FROM", "alerts@flowminer.io")
            msg["To"] = ", ".join(recipients)
            msg.attach(MIMEText(body, "plain"))

            smtp_host = getattr(settings, "SMTP_HOST", "localhost")
            smtp_port = int(getattr(settings, "SMTP_PORT", 587))
            smtp_user = getattr(settings, "SMTP_USER", "")
            smtp_pass = getattr(settings, "SMTP_PASS", "")

            with smtplib.SMTP(smtp_host, smtp_port, timeout=10) as server:
                # Always STARTTLS unless the relay is local. Previously
                # STARTTLS only fired when both user+pass were set, so
                # an unauthenticated upstream relay would ship the
                # alert body over cleartext SMTP.
                if smtp_host not in ("localhost", "127.0.0.1"):
                    try:
                        server.starttls()
                    except smtplib.SMTPException as tls_exc:
                        logger.error(
                            "STARTTLS failed for alert %s on %s:%s — "
                            "refusing to send cleartext: %s",
                            alert.id, smtp_host, smtp_port, tls_exc,
                        )
                        return
                if smtp_user and smtp_pass:
                    server.login(smtp_user, smtp_pass)
                server.send_message(msg)

            logger.info(
                "Email sent for alert %s to %s", alert.id, recipients
            )
        except Exception as exc:
            logger.error(
                "Email delivery failed for alert %s: %s", alert.id, exc
            )

    def _send_webhook(self, alert, result: dict) -> None:
        """POST a JSON payload to the configured webhook URL."""
        url = _safe_webhook_url(alert.webhook_url, alert.id)
        if not url:
            return

        payload = {
            "alert_name": alert.name,
            "triggered": result["triggered"],
            "metric": alert.metric,
            "current_value": result["current_value"],
            "condition": (
                alert.condition.value
                if hasattr(alert.condition, "value")
                else str(alert.condition)
            ),
            "threshold": alert.threshold,
            "message": result["message"],
        }

        try:
            with httpx.Client(timeout=10, follow_redirects=False) as client:
                resp = client.post(url, json=payload)
                resp.raise_for_status()
            logger.info("Webhook sent for alert %s to %s", alert.id, url)
        except Exception as exc:
            logger.error(
                "Webhook delivery failed for alert %s: %s", alert.id, exc
            )

    def _send_slack(self, alert, result: dict) -> None:
        """POST a message to a Slack incoming webhook URL."""
        url = _safe_webhook_url(alert.webhook_url, alert.id)
        if not url:
            return

        status_emoji = "\U0001f534" if result["triggered"] else "\U0001f7e2"  # red / green circle
        payload = {
            "text": (
                f"{status_emoji} *{alert.name}*\n{result['message']}"
            )
        }

        try:
            with httpx.Client(timeout=10, follow_redirects=False) as client:
                resp = client.post(url, json=payload)
                resp.raise_for_status()
            logger.info("Slack notification sent for alert %s", alert.id)
        except Exception as exc:
            logger.error(
                "Slack delivery failed for alert %s: %s", alert.id, exc
            )

    def _send_teams(self, alert, result: dict) -> None:
        """POST an Adaptive Card to a Microsoft Teams incoming webhook.

        The payload follows the Adaptive Card 1.4 spec — Teams renders
        title + facts + actions inline. Colors on the fact row (attention /
        good) come from the alert trigger state.
        """
        url = _safe_webhook_url(alert.webhook_url, alert.id)
        if not url:
            return

        triggered = result.get("triggered", False)
        color = "attention" if triggered else "good"
        payload = {
            "type": "message",
            "attachments": [
                {
                    "contentType": "application/vnd.microsoft.card.adaptive",
                    "content": {
                        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                        "type": "AdaptiveCard",
                        "version": "1.4",
                        "body": [
                            {
                                "type": "TextBlock",
                                "text": alert.name,
                                "weight": "Bolder",
                                "size": "Medium",
                                "color": color,
                            },
                            {
                                "type": "TextBlock",
                                "text": result.get("message", ""),
                                "wrap": True,
                            },
                            {
                                "type": "FactSet",
                                "facts": [
                                    {"title": "Metric", "value": str(getattr(alert, "metric", "") or "")},
                                    {"title": "Current", "value": str(result.get("current_value", ""))},
                                    {"title": "Threshold", "value": str(getattr(alert, "threshold_value", getattr(alert, "threshold", "")) or "")},
                                    {"title": "Status", "value": "TRIGGERED" if triggered else "OK"},
                                ],
                            },
                        ],
                    },
                }
            ],
        }

        try:
            with httpx.Client(timeout=10, follow_redirects=False) as client:
                resp = client.post(url, json=payload)
                resp.raise_for_status()
            logger.info("Teams notification sent for alert %s", alert.id)
        except Exception as exc:
            logger.error("Teams delivery failed for alert %s: %s", alert.id, exc)
