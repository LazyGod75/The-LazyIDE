"""Validate lazybrain_read.py against an installed mistral-vibe.

Usage:  python scripts/check-vibe-tool.py
Requires: pip install mistral-vibe   (no API key needed -- imports only)
Exit 0 = tool imports cleanly and registers as "read" (or SKIP if vibe absent).
"""

import importlib.util
import pathlib
import sys

TOOL = (
    pathlib.Path(__file__).parent.parent
    / "plugins" / "lazybrain" / "vibe" / "tools" / "lazybrain_read.py"
)

spec = importlib.util.spec_from_file_location("lazybrain_read", TOOL)
module = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(module)
except ModuleNotFoundError as err:
    print(f"SKIP: mistral-vibe not installed ({err})")
    sys.exit(0)

name = module.Read.get_name()
assert name == "read", f"expected tool name 'read', got {name!r}"
assert module._needle("C:\\proj\\acme\\src\\payments\\stripe.ts") == "payments/stripe.ts"
assert 'data-cerveau-files-modified*="payments/stripe.ts"' in module._selector("payments/stripe.ts")
print("OK: lazybrain_read.py registers as 'read' and builds correct selectors")
