#!/bin/bash

# HTML vs Markdown Benchmark Runner
# This script benchmarks LazyBrain (HTML format) against equivalent Markdown implementations
# for LLM agent memory systems across 4 key dimensions.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."

echo "HTML vs Markdown Memory Benchmark"
echo "═════════════════════════════════"
echo ""
echo "Measuring across 4 dimensions:"
echo "  1. Query expressiveness (10 scenarios)"
echo "  2. Strip ratio (HTML size vs stripped text)"
echo "  3. Structural query latency (CSS vs YAML parsing)"
echo "  4. Token efficiency (injected context size)"
echo ""

# Ensure LazyBrain is built
echo "Building LazyBrain..."
cd "$PROJECT_DIR"
npm run build > /dev/null 2>&1

# Run benchmark
echo "Running benchmark..."
npx tsx bench/html-vs-md.ts

echo ""
echo "View full results in: bench/results/"
ls -lh bench/results/html-vs-md-*.json | tail -1
