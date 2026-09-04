"""Pier / Harbor custom agent that drives the Lazy CLI (`lazy bench`).

This adapter makes Terminal-Bench 2.1 and DeepSWE benchmark LazyIDE's headless
harness — the same LazyManager-level tool loop the IDE runs headless
(read_dir / find_file / search_code / read / edit / write / bash).

How it works (no file-sync dependency — works on docker, modal and daytona):
  1. run() transfers the host `dist/cli/lazy.cjs` bundle into the sandbox as
     /opt/lazy/lazy.cjs (base64, chunked).
  2. Writes the task instruction to /app/instruction.txt.
  3. Runs `node /opt/lazy/lazy.cjs bench --task-file /app/instruction.txt
     --workdir /app --commit --json` with the DeepSeek env vars.
  `--commit` is required: DeepSWE grades the committed patch via its
  pre_artifacts.sh.

The DeepSeek API is reachable from inside the sandbox via the agent's network
allowlist (Pier's per-agent network allowlist). Exit codes from `lazy bench`
never fail the trial — the benchmark verifier is the judge.

Usage with Pier (DeepSWE):
    PYTHONPATH=bench/adapters pier run -p deep-swe/tasks \\
        --agent-import-path lazy_agent:LazyAgent \\
        --model deepseek/deepseek-v4-flash \\
        --ae DEEPSEEK_API_KEY=sk-... \\
        --ae LAZY_CLI_BUNDLE=C:/path/to/Lazy/dist/cli/lazy.cjs \\
        --env modal

Usage with Harbor (Terminal-Bench 2.1):
    PYTHONPATH=bench/adapters harbor run -d terminal-bench/terminal-bench-2-1 \\
        --agent-import-path lazy_agent:LazyAgent \\
        --model deepseek/deepseek-v4-flash \\
        --ae DEEPSEEK_API_KEY=sk-... \\
        --ae LAZY_CLI_BUNDLE=C:/path/to/Lazy/dist/cli/lazy.cjs \\
        -e daytona
"""

import base64
import os
from pathlib import Path
from urllib.parse import urlparse

from pier.agents.installed.base import BaseInstalledAgent
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep
from pier.models.agent.network import NetworkAllowlist

_B64_CHUNK = 120_000


class LazyAgent(BaseInstalledAgent):
    """Runs `lazy bench` (LazyManager-level tool loop) inside the sandbox."""

    SUPPORTS_ATIF = False

    @staticmethod
    def name() -> str:
        return "lazy-bench"

    def __init__(self, logs_dir, model_name=None, logger=None, max_steps=80, *args, **kwargs):
        super().__init__(logs_dir, model_name=model_name, logger=logger, *args, **kwargs)
        self.max_steps = int(self._get_env("LAZY_AGENT_MAX_STEPS") or max_steps)
        self._cli_bundle = self._get_env("LAZY_CLI_BUNDLE") or str(
            Path(__file__).resolve().parents[2] / "dist" / "cli" / "lazy.cjs"
        )
        self._idebench_bundle = self._get_env("LAZY_IDEBENCH_BUNDLE") or str(
            Path(__file__).resolve().parents[2] / "dist" / "cli" / "idebench.cjs"
        )

    def version(self) -> str | None:
        return os.environ.get("LAZY_VERSION", "0.1.18")

    def install_spec(self) -> AgentInstallSpec:
        # Best-effort node install (the sandbox may already have node).
        root_install = (
            "if command -v node >/dev/null 2>&1; then true; "
            "elif command -v apk >/dev/null 2>&1; then apk add --no-cache nodejs npm; "
            "elif command -v apt-get >/dev/null 2>&1; then "
            "apt-get update -qq && apt-get install -y -qq nodejs npm; "
            "elif command -v dnf >/dev/null 2>&1; then dnf install -y nodejs npm; "
            "else echo 'WARN: could not install node; is node already present?' >&2; fi"
        )
        return AgentInstallSpec(
            agent_name=self.name(),
            version=self.version(),
            steps=[InstallStep(user="root", run=root_install)],
            verification_command="node --version",
        )

    def network_allowlist(self) -> NetworkAllowlist:
        base_url = self._get_env("DEEPSEEK_API_URL") or "https://api.deepseek.com"
        host = urlparse(base_url if "://" in base_url else f"https://{base_url}").hostname
        return NetworkAllowlist(domains=[host or "api.deepseek.com"])

    async def _transfer_bundle(self, environment: BaseEnvironment) -> None:
        bench_bin = self._get_env("LAZY_BENCH_BIN") or "bench"
        if bench_bin == "idebench":
            bundle_path = Path(self._idebench_bundle)
            target = "/opt/lazy/idebench.cjs"
        else:
            bundle_path = Path(self._cli_bundle)
            target = "/opt/lazy/lazy.cjs"
        if not bundle_path.exists():
            raise RuntimeError(
                f"LAZY bundle not found: {bundle_path} — run `npm run build:cli` / `npm run build:idebench` first"
            )
        b64 = base64.b64encode(bundle_path.read_bytes()).decode("ascii")
        await environment.exec("mkdir -p /opt/lazy", user="root", timeout_sec=30)
        await environment.exec("rm -f /opt/lazy/_b64", user="root", timeout_sec=30)
        for i in range(0, len(b64), _B64_CHUNK):
            chunk = b64[i : i + _B64_CHUNK]
            await environment.exec(
                f"echo {chunk} >> /opt/lazy/_b64", user="root", timeout_sec=120
            )
        result = await environment.exec(
            f"base64 -d /opt/lazy/_b64 > {target} && "
            "rm -f /opt/lazy/_b64 && chmod 644 /opt/lazy/_b64 2>/dev/null; chmod 644 "
            f"{target} && node --check {target}",
            user="root",
            timeout_sec=120,
        )
        if result.return_code != 0:
            raise RuntimeError(f"bundle transfer/check failed: {result.stderr or result.stdout}")

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        bench_bin = self._get_env("LAZY_BENCH_BIN") or "bench"
        bundle = self._idebench_bundle if bench_bin == "idebench" else self._cli_bundle
        self.logger.info(
            "LazyAgent: transferring CLI bundle %s (LAZY_BENCH_BIN=%s)", bundle, bench_bin
        )
        await self._transfer_bundle(environment)

        # Write the instruction as a file (never inline — instruction may contain
        # shell metacharacters).
        inst_b64 = base64.b64encode(instruction.encode("utf-8")).decode("ascii")
        await environment.exec(
            f"echo {inst_b64} | base64 -d > /app/instruction.txt", timeout_sec=30
        )

        # Capture the base commit so we can emit model.patch (the DeepSWE artifact
        # contract: the harness writes the change set to /logs/artifacts/model.patch).
        base_res = await environment.exec(
            "git -C /app rev-parse HEAD", timeout_sec=30
        )
        base_sha = (base_res.stdout or "").strip()

        env = {
            "DEEPSEEK_API_KEY": self._get_env("DEEPSEEK_API_KEY") or "",
            "DEEPSEEK_API_URL": self._get_env("DEEPSEEK_API_URL") or "",
            "DEEPSEEK_MODEL": self._get_env("DEEPSEEK_MODEL") or "",
            "LAZY_AGENT_MAX_STEPS": str(self.max_steps),
        }
        env = self.build_process_env(env, include_resolved_env=False)
        env = {k: v for k, v in env.items() if v}

        model_flag = ""
        if self._get_env("DEEPSEEK_MODEL"):
            model_flag = f"--model {self._get_env('DEEPSEEK_MODEL')}"
        # LAZY_BENCH_BIN: "bench" (default, CLI harness) | "idebench" (headless IDE harness)
        bench_bin = self._get_env("LAZY_BENCH_BIN") or "bench"
        if bench_bin == "idebench":
            cmd = (
                "cd /app && "
                "node /opt/lazy/idebench.cjs "
                f"--task-file /app/instruction.txt --workdir /app --commit "
                f"--max-steps {self.max_steps}"
            )
        else:
            cmd = (
                "cd /app && "
                "node /opt/lazy/lazy.cjs bench "
                f"--task-file /app/instruction.txt --workdir /app --commit --json "
                f"--max-steps {self.max_steps} {model_flag}"
            )
        self.logger.info("LazyAgent: running %s", cmd)
        result = await environment.exec(cmd, env=env, timeout_sec=3600)
        self.logger.info("LazyAgent: stdout tail:\n%s", (result.stdout or "")[-4000:])
        self.logger.info("LazyAgent: stderr tail:\n%s", (result.stderr or "")[-2000:])

        # DeepSWE artifact contract: emit the agent's change set as model.patch.
        if base_sha:
            patch_res = await environment.exec(
                f"mkdir -p /logs/artifacts && "
                f"cd /app && git add -A && "
                f"git diff {base_sha}..HEAD --binary > /logs/artifacts/model.patch; "
                f"wc -c < /logs/artifacts/model.patch",
                timeout_sec=60,
            )
            self.logger.info(
                "LazyAgent: model.patch bytes: %s",
                (patch_res.stdout or "").strip(),
            )

        context.metadata = {
            "agent": self.name(),
            "version": self.version(),
            "model": self.model_name,
            "max_steps": self.max_steps,
            "bench_exit_code": result.return_code,
            "base_sha": base_sha,
        }

    def populate_context_post_run(self, context: "AgentContext") -> None:
        """BaseInstalledAgent hook — nothing to parse for a JSON-protocol agent."""
        return None

