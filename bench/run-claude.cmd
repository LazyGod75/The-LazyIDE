@echo off
REM Overnight benchmark — Claude Sonnet (solo vs +brain vs +LazyIDE)
cd /d C:\Users\user\Documents\cerveau\Lazy
node bench\claude-ab.mjs --model sonnet > bench\results\run-claude.log 2>&1
