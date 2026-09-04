@echo off
REM Overnight benchmark — DeepSeek (solo vs +brain vs +LazyIDE via idebench deepseek)
cd /d "%~dp0.."
REM Never hardcode an API key — read it from the environment.
if "%DEEPSEEK_API_KEY%"=="" (
  echo Set your DEEPSEEK_API_KEY in the environment and re-run.
  exit /b 1
)
node bench\claude-ab.mjs --backend deepseek > bench\results\run-deepseek.log 2>&1
