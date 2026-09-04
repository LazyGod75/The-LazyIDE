---
name: lazybrain-summary
description: Vue d'ensemble du brain (stats, distribution des routing levels, recall structural). Idéal pour comprendre l'état général.
allowed-tools: [Bash]
disabled-model-invocation: false
---

# LazyBrain Stats

Affiche les métriques live du brain : nombre de notes, distribution par type, latence p50 par level, taux de recall structural.

## Usage

```
/lazybrain-summary
/lazybrain-summary 168   # window 7 jours
```

## Exécution

!`lazybrain stats --window-hours ${1:-24} --pretty 2>/dev/null || echo "[lazybrain: not configured]"`
