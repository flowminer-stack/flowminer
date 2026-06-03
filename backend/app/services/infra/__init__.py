"""Cross-cutting infrastructure utilities.

This subpackage groups the framework-level services (rate limiting, request
IDs, logging, secret handling, auditing, etc.) that the rest of the app depends
on. It acts as a re-export barrel so callers can use either form::

    from app.services.infra import audit
    from app.services.infra.audit import AuditLogMiddleware

Submodules are resolved lazily via :pep:`562` ``__getattr__`` so that simply
importing the package (or one submodule through it) does not eagerly drag in
the others.
"""

from importlib import import_module

__all__ = [
    "audit",
    "logging_setup",
    "notifier",
    "password_policy",
    "rate_limit",
    "request_id",
    "result_cache",
    "safe_expression",
    "secret_box",
    "token_revocation",
    "url_guard",
    "usage",
]


def __getattr__(name: str):
    if name in __all__:
        module = import_module(f"{__name__}.{name}")
        globals()[name] = module
        return module
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__():
    return sorted(set(__all__) | set(globals()))
