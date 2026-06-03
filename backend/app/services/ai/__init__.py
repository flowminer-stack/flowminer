"""AI / LLM-facing services.

Groups the LLM client, chat tool definitions, and agent-mining helpers. Acts as
a re-export barrel so callers can use either form::

    from app.services.ai import llm
    from app.services.ai.llm import complete

Submodules are resolved lazily via :pep:`562` ``__getattr__`` to avoid eagerly
importing the heavier mining dependencies pulled in by ``chat_tools`` /
``agent_mining`` when only ``llm`` is needed.
"""

from importlib import import_module

__all__ = [
    "agent_mining",
    "chat_tools",
    "llm",
]


def __getattr__(name: str):
    if name in __all__:
        module = import_module(f"{__name__}.{name}")
        globals()[name] = module
        return module
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__():
    return sorted(set(__all__) | set(globals()))
