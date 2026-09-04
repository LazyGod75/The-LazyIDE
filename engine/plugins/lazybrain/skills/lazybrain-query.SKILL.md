---
name: lazybrain-query
description: Query CSS selector déterministe sur le brain (L1, &lt; 5ms). Utiliser pour des filtres exacts par tags, type, date, ou tout attribut data-cerveau-*.
allowed-tools: [Bash]
disabled-model-invocation: false
---

# LazyBrain Query (structural)

Exécute une requête CSS selector déterministe sur le brain HTML. C'est le mode le plus rapide et le moins coûteux : zéro LLM, zéro embedding.

## Exemples de selectors

```
article[data-cerveau-type="decision"]
article[data-cerveau-tags~="auth"]
article[data-cerveau-valid-from^="2026-05"]:not([data-cerveau-valid-until])
p[data-cerveau-fact][data-cerveau-confidence="1.00"]
a[data-cerveau-link-type="contradicts"]
```

## Usage

```
/lazybrain-query article[data-cerveau-type="decision"]
/lazybrain-query "[data-cerveau-tags~='security']" --strip
```

## Exécution

!`lazybrain query "$ARGUMENTS" --pretty 2>/dev/null || echo "[lazybrain: not configured]"`
