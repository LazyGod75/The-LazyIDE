---
id: acme/concepts
type: concept
topic: acme/concepts
created: 2026-05-16T00:00:00Z
confidence: 0.75
tags: [concept, feature, acme, cal, nutrition, tracking]
---

# Feature: Cal — calorie and nutrition tracking

## Tldr

The cal feature adds calorie and macro-nutrient tracking to acme-app. Not a calendar feature — cal = calories.

## Body

Feature recorded 2026-05-16. The cal module (acme-app/app/details/cal/, acme-app/components/cal/) implements daily calorie logging and macro breakdown visualization. Users can scan barcodes, manually enter meals, and view weekly macro trends. The build bug #799 and #851 were triggered by incomplete TypeScript types in this module.

## Related

Related neurons acme-app/app/details/cal/index.jsx acme-app/components/cal/ModernMacroCard.jsx