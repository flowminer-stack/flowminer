"""Regression tests for action-rule dispatch (audit: headline feature was a stub).

Guards:
  * _NotifyAdapter must carry the .metric/.condition/.threshold attributes that
    Notifier._send_email/_send_webhook read BEFORE their try-blocks — otherwise
    every real notify dispatch raised AttributeError and was recorded as failed.
  * dry_run must perform NO side effects.
  * notify_email must NOT report success when SMTP is unconfigured.
  * recorded success must reflect the real transport outcome.
"""

import pytest

from app.services import action_engine

CASE = {"case_id": "case-1", "case_duration": 3600.0}


class _FakeNotifier:
    """Mimics the exact attributes the real Notifier reads off the adapter, so a
    missing attribute surfaces as AttributeError (exactly the production bug)."""

    def __init__(self):
        self.email_calls = []
        self.webhook_calls = []

    def _send_email(self, alert, result):
        # Real Notifier reads these before its try-block:
        _ = (alert.id, alert.name, alert.email_recipients, alert.metric,
             alert.condition, alert.threshold)
        self.email_calls.append(alert)

    def _send_webhook(self, alert, result):
        _ = (alert.id, alert.name, alert.webhook_url, alert.metric,
             alert.condition, alert.threshold)
        self.webhook_calls.append(alert)

    def _send_slack(self, alert, result):
        _ = (alert.id, alert.name, alert.webhook_url)


async def test_dry_run_has_no_side_effects():
    fake = _FakeNotifier()
    action = {"type": "notify_email", "params": {"to": "a@b.com"}}
    detail = await action_engine.dispatch_action(action, CASE, dry_run=True, notifier=fake)
    assert "success" not in detail            # intent only
    assert fake.email_calls == []             # nothing sent


async def test_notify_webhook_adapter_has_required_attrs():
    """If _NotifyAdapter lost .metric/.condition/.threshold this would raise
    inside the fake (as the real Notifier did) and success would be False."""
    fake = _FakeNotifier()
    action = {"type": "notify_webhook", "params": {"url": "https://example.com/hook"}}
    detail = await action_engine.dispatch_action(action, CASE, dry_run=False, notifier=fake)
    assert detail["success"] is True, detail
    assert len(fake.webhook_calls) == 1
    adapter = fake.webhook_calls[0]
    assert hasattr(adapter, "metric") and hasattr(adapter, "condition") and hasattr(adapter, "threshold")


async def test_notify_email_not_reported_success_when_smtp_unset(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "SMTP_HOST", "", raising=False)
    fake = _FakeNotifier()
    action = {"type": "notify_email", "params": {"to": "a@b.com"}}
    detail = await action_engine.dispatch_action(action, CASE, dry_run=False, notifier=fake)
    assert detail["success"] is False
    assert "smtp" in (detail.get("note", "") + detail.get("error", "")).lower()
    assert fake.email_calls == []             # never actually delegated


async def test_failure_is_recorded_not_swallowed_as_success():
    class _Boom(_FakeNotifier):
        def _send_webhook(self, alert, result):
            raise RuntimeError("connection refused")

    action = {"type": "notify_webhook", "params": {"url": "https://example.com/hook"}}
    detail = await action_engine.dispatch_action(action, CASE, dry_run=False, notifier=_Boom())
    assert detail["success"] is False
    assert "error" in detail
