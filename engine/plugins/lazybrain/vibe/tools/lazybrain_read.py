"""LazyBrain spatial recall for Mistral Vibe.

Drop this file into ~/.vibe/tools/ (lazybrain init --agent vibe --tools does it).

It REPLACES Vibe's builtin `read` tool: the class is deliberately named `Read`
so ToolManager's last-wins registration overrides the builtin (user tool dirs
are loaded after builtins). Only get_result_extra() is overridden — the builtin
read behavior (including subdirectory AGENTS.md injection) is fully preserved
via super(). When the model reads a file that the brain knows about, settled
facts scoped to that file are appended to the tool result: memory surfaces
exactly where and when the agent navigates, at zero schema-token cost.

Failure policy: ANY error falls back to the builtin behavior silently. A
broken brain must never break `read`. (Note: Vibe swallows import errors in
custom tools, so if mistral-vibe internals change, the tool simply vanishes
instead of crashing — by design.)

Latency: one `lazybrain query` subprocess per UNIQUE directory needle per
session (deduped via an instance-level set), hard-capped at LB_TIMEOUT_S.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import PurePath

from vibe.core.tools.builtins.read import Read as BuiltinRead

LB_TIMEOUT_S = 0.8
LB_MAX_CHARS = 1500
LB_RESULT_LIMIT = "3"


def _needle(file_path: str) -> str:
    """Project-relative-ish needle: last two path segments, forward slashes.

    Brain notes store project-relative forward-slash paths in
    data-cerveau-files-modified / data-cerveau-files-read, so the last two
    segments ("payments/stripe.ts") are a precise substring match.
    """
    parts = PurePath(file_path.replace("\\", "/")).parts
    tail = parts[-2:] if len(parts) >= 2 else parts
    return "/".join(tail)


def _selector(needle: str) -> str:
    escaped = needle.replace('"', "")
    return (
        f'article[data-cerveau-files-modified*="{escaped}"]'
        ":not([data-cerveau-valid-until])"
    )


def _recall(file_path: str) -> str | None:
    binary = shutil.which("lazybrain")
    if not binary:
        return None
    needle = _needle(file_path)
    if not needle:
        return None
    try:
        proc = subprocess.run(
            [binary, "query", _selector(needle), "--strip", "--limit", LB_RESULT_LIMIT],
            capture_output=True,
            text=True,
            timeout=LB_TIMEOUT_S,
        )
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    out = (proc.stdout or "").strip()
    if not out or out in ("[]", "null"):
        return None
    return out[:LB_MAX_CHARS]


class Read(BuiltinRead):  # noqa: N801 - name drives tool registration ("read")
    """Builtin read + LazyBrain spatial recall via get_result_extra."""

    def get_result_extra(self, result):  # type: ignore[override]
        base = super().get_result_extra(result)
        try:
            file_path = getattr(result, "file_path", None)
            if not file_path:
                return base
            seen = getattr(self, "_lazybrain_seen", None)
            if seen is None:
                seen = set()
                self._lazybrain_seen = seen
            key = _needle(str(file_path))
            if key in seen:
                return base
            seen.add(key)
            hits = _recall(str(file_path))
            if not hits:
                return base
            block = (
                "<lazybrain-memory>\n"
                f"Settled knowledge about {key} (deterministic recall — do not re-litigate):\n"
                f"{hits}\n"
                "</lazybrain-memory>"
            )
            return f"{base}\n\n{block}" if base else block
        except Exception:
            return base
