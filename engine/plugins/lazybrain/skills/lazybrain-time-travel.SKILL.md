---
name: lazybrain-time-travel
description: Inspecte l'état des facts à une date donnée. Utilise les attributs data-cerveau-valid-from/until pour reconstruire la vérité passée.
allowed-tools: [Bash]
disabled-model-invocation: false
---

# LazyBrain Time-Travel

Reconstruit l'état de la mémoire à un moment spécifique du passé. Montre uniquement les facts qui étaient valides à cette date.

## Bi-Temporal Semantics

LazyBrain distingue deux types de timestamps:

- **`data-cerveau-valid-from`**: Date à laquelle le fait est devenu vrai (validité commence)
- **`data-cerveau-valid-until`**: Date à laquelle le fait a cessé d'être vrai (validité se termine)
- **`data-cerveau-created`** / **`data-cerveau-updated`**: Quand la note a été créée/modifiée (orthogonal)

Un fact est valide à une date D si:
- `valid-from <= D`
- ET (`valid-until` est absent OU `valid-until > D`)

## Usage

```
/lazybrain-time-travel 2026-03-15
/lazybrain-time-travel 2026-01-15 --tag database
```

## Exemples

**"Quelle était notre stack DB en janvier?"**
```
/lazybrain-time-travel 2026-01-15 --tag database
```
Retourne toutes les décisions de BD valides en janvier: celles où `valid-from <= 2026-01-15` et (`valid-until` absent ou `> 2026-01-15`).

**"Quel était l'état de l'auth avant la refonte?"**
```
/lazybrain-time-travel 2026-02-01 --tag auth
```
Capture la configuration auth avant les changements de mars.

## Implementation

Extracts temporal boundaries from article fragments and applies time-travel filtering.

!`
ASOF="${1:-$(date +%Y-%m-%d)}"

echo "[time-travel] Brain state as of $ASOF"
echo ""

lazybrain query 'article[data-cerveau-valid-from]' --limit=200 2>/dev/null | python3 << 'PYEOF'
import json
import sys
import re
from datetime import datetime

asof = "$ASOF"
data = json.load(sys.stdin)

def parse_date(s):
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except:
        return None

target_date = parse_date(asof)
if not target_date:
    print(f"Invalid date: {asof}")
    sys.exit(1)

matches = 0
for hit in data.get('hits', []):
    fragment = hit.get('fragment', '')
    
    # Extract valid-from and valid-until from HTML
    from_match = re.search(r'data-cerveau-valid-from="([^"]+)"', fragment)
    until_match = re.search(r'data-cerveau-valid-until="([^"]+)"', fragment)
    
    if not from_match:
        continue
    
    from_date = parse_date(from_match.group(1))
    until_date = parse_date(until_match.group(1)) if until_match else None
    
    if not from_date:
        continue
    
    # Check if fact was valid on target date
    if from_date <= target_date and (until_date is None or until_date > target_date):
        matches += 1
        valid_period = f"{from_date}"
        if until_date:
            valid_period += f" → {until_date}"
        else:
            valid_period += " → present"
        
        print(f"  • {hit['noteId']}  [{valid_period}]")
        if hit['text']:
            preview = hit['text'].split('\n')[0][:120]
            print(f"      {preview}")
        if matches >= 50:
            break

print(f"\nFound {matches} facts valid on {asof}")
PYEOF
` || echo "[lazybrain: not configured]"`

