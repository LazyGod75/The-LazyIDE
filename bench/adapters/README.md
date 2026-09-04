# LazyIDE adapters — Terminal-Bench 2.1 / DeepSWE

This directory contains the adapter that lets **Pier** (DeepSWE) and **Harbor**
(Terminal-Bench) drive the LazyIDE headless harness — `lazy bench`, the
LazyManager-level tool loop (read_dir / find_file / search_code / read / edit /
write / bash) backed by DeepSeek.

- `lazy_agent.py` — Pier/Harbor custom agent (`--agent-import-path lazy_agent:LazyAgent`).
  Works on `docker`, `modal` and `daytona` environments (no file-sync dependency:
  it base64-transfers `dist/cli/lazy.cjs` into the sandbox at runtime).

## Requirements

1. Build the CLI bundle once:
   ```sh
   npm run build:cli        # → dist/cli/lazy.cjs
   ```
2. Have a DeepSeek key: `DEEPSEEK_API_KEY`.
3. Point the adapter at the bundle: `--ae LAZY_CLI_BUNDLE=<abs path to dist/cli/lazy.cjs>`.

## Quick start

```sh
# DeepSWE (Pier) — subset of 10 tasks
PYTHONPATH=bench/adapters pier run -p deep-swe/tasks --n-tasks 10 --sample-seed 0 \
  --agent-import-path lazy_agent:LazyAgent \
  --model deepseek/deepseek-v4-flash \
  --ae DEEPSEEK_API_KEY=sk-... \
  --ae LAZY_CLI_BUNDLE=/abs/path/dist/cli/lazy.cjs \
  --env modal

# Terminal-Bench 2.1 (Harbor) — local validation
PYTHONPATH=bench/adapters harbor run -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path lazy_agent:LazyAgent \
  --model deepseek/deepseek-v4-flash \
  --ae DEEPSEEK_API_KEY=sk-... \
  --ae LAZY_CLI_BUNDLE=/abs/path/dist/cli/lazy.cjs \
  -e daytona -k 1
```

Full walkthrough, honest comparison protocol and cost estimates:
see `docs/BENCH-INTEGRATION.md`.
