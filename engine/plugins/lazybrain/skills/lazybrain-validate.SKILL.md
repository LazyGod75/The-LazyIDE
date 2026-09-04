---
name: lazybrain-validate
description: End-to-end validation. Wipes brain, runs full pipeline 3 times via skills, verifies deterministic output and zero manual steps. Use to prove the pipeline works for anyone.
allowed-tools: [Bash, PowerShell]
disabled-model-invocation: false
---

# LazyBrain Validate (E2E)

Runs the full pipeline 3 times from scratch via the official skills. Proves:
- Zero hardcoded paths
- Deterministic output across runs
- All skills work without manual intervention
- Wiki/search/inject all functional

## Run 1: Clean slate

!`lazybrain wipe --pretty 2>/dev/null`
!`lazybrain dream --enrich --pretty 2>/dev/null`
!`lazybrain index-rebuild --pretty 2>/dev/null`
!`lazybrain graph --format both --pretty 2>/dev/null`
!`lazybrain build-hierarchy --force --pretty 2>/dev/null`
!`lazybrain enrich-hierarchy --force --pretty 2>/dev/null`
!`lazybrain stats --pretty 2>/dev/null`

Save the stats output as **run1_stats**.

## Run 2: Repeat

!`lazybrain wipe --pretty 2>/dev/null`
!`lazybrain dream --enrich --pretty 2>/dev/null`
!`lazybrain index-rebuild --pretty 2>/dev/null`
!`lazybrain graph --format both --pretty 2>/dev/null`
!`lazybrain build-hierarchy --force --pretty 2>/dev/null`
!`lazybrain enrich-hierarchy --force --pretty 2>/dev/null`
!`lazybrain stats --pretty 2>/dev/null`

Save as **run2_stats**.

## Run 3: Final repeat

!`lazybrain wipe --pretty 2>/dev/null`
!`lazybrain dream --enrich --pretty 2>/dev/null`
!`lazybrain index-rebuild --pretty 2>/dev/null`
!`lazybrain graph --format both --pretty 2>/dev/null`
!`lazybrain build-hierarchy --force --pretty 2>/dev/null`
!`lazybrain enrich-hierarchy --force --pretty 2>/dev/null`
!`lazybrain stats --pretty 2>/dev/null`

Save as **run3_stats**.

## Verification

Compare run1/run2/run3 stats. Report:
- **Deterministic**: identical node/edge counts? PASS/FAIL
- **Search works**: !`lazybrain search "test" --pretty 2>/dev/null`
- **Inject works**: !`lazybrain inject-context --pretty 2>/dev/null | head -20`
- **Wiki reachable**: !`Invoke-WebRequest http://localhost:4242 -TimeoutSec 5 -ErrorAction SilentlyContinue | Select-Object StatusCode`

## Pass criteria
- 3 runs complete with no errors
- Node count identical across runs (deterministic)
- Edge count identical across runs
- Cluster count identical across runs
- Search returns results
- Inject produces output
- Wiki returns HTTP 200

If ANY criterion fails, the pipeline has a bug that must be fixed in the SKILLS or CODE (not by manual intervention).
