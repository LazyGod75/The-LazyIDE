import { describe, it, expect } from 'vitest';
import { stripArtifactEnvelope } from '../lib/agents/artifactEnvelopeLeak';

// Regression coverage for the confirmed LazyManager Cockpit panel leak
// (2026-08): a raw `<artifact type="..." id="...">{...json...}</artifact>`
// result envelope rendered verbatim as chat text, verbatim repro:
//   ...ce qui doit être corrigé. <artifact type="application/json"
//   id="query-m7"> {"type": "query_miss...
// plus a stray closing fragment observed elsewhere in the same session (a
// mission list preview): `M7"} </artifact> ~3 crédits`.

describe('stripArtifactEnvelope — complete envelope', () => {
  it('strips a complete <artifact type="..." id="..."> block, keeping surrounding prose', () => {
    const text =
      "Voici ce qui n'a pas fonctionné et ce qui doit être corrigé. " +
      '<artifact type="application/json" id="query-m7">{"type": "query_miss", "missionId": "M7"}</artifact>' +
      ' Peux-tu relancer la mission ?';
    const result = stripArtifactEnvelope(text);
    expect(result).toContain("Voici ce qui n'a pas fonctionné et ce qui doit être corrigé.");
    expect(result).toContain('Peux-tu relancer la mission ?');
    expect(result).not.toContain('<artifact');
    expect(result).not.toContain('</artifact>');
    expect(result).not.toContain('query_miss');
  });

  it('strips multiple complete <artifact> blocks', () => {
    const text = 'A <artifact id="1">{"x":1}</artifact> B <artifact id="2">{"y":2}</artifact> C';
    const result = stripArtifactEnvelope(text);
    expect(result).toContain('A');
    expect(result).toContain('B');
    expect(result).toContain('C');
    expect(result).not.toContain('artifact');
  });
});

describe('stripArtifactEnvelope — truncated/unterminated envelope', () => {
  it('strips an UNTERMINATED <artifact> block (stream cut off mid-payload) leaving no dangling fragment', () => {
    const text =
      'Real prose before the cut. ' +
      '<artifact type="application/json" id="query-m7"> {"type": "query_miss';
    const result = stripArtifactEnvelope(text);
    expect(result).toBe('Real prose before the cut.');
    expect(result).not.toContain('artifact');
    expect(result).not.toContain('query_miss');
    expect(result).not.toContain('{');
  });

  it('is idempotent on an already-truncated result', () => {
    const text = 'Kept.\n<artifact id="x">{"partial';
    const once = stripArtifactEnvelope(text);
    const twice = stripArtifactEnvelope(once);
    expect(twice).toBe(once);
    expect(once).toBe('Kept.');
  });
});

describe('stripArtifactEnvelope — stray closing tag (opening tag missing/mismatched)', () => {
  it('strips a stray closing tag with a well-formed JSON object glued to it', () => {
    const text = '{"type": "query_miss", "missionId": "M7"} </artifact> ~3 crédits';
    const result = stripArtifactEnvelope(text);
    expect(result).not.toContain('artifact');
    expect(result).not.toContain('{"type"');
    expect(result).toContain('~3 crédits');
  });

  it('strips a stray closing tag alone, with no JSON immediately before it', () => {
    const text = 'Réponse propre.\n</artifact>';
    const result = stripArtifactEnvelope(text);
    expect(result).not.toContain('artifact');
    expect(result).toContain('Réponse propre.');
  });

  it('never touches real prose surrounding a stray closing tag', () => {
    const text = 'Avant.\n{"a": 1} </artifact>\nAprès.';
    const result = stripArtifactEnvelope(text);
    expect(result).toContain('Avant.');
    expect(result).toContain('Après.');
    expect(result).not.toContain('{"a"');
    expect(result).not.toContain('artifact');
  });
});

describe('stripArtifactEnvelope — false-positive guards', () => {
  it('leaves clean text with no envelope completely unchanged', () => {
    const text = 'The mission is 60% complete and on track.';
    expect(stripArtifactEnvelope(text)).toBe(text);
  });

  it('is idempotent on already-sanitized leaky text', () => {
    const text = '<artifact id="x">{"a":1}</artifact>Answer.';
    const once = stripArtifactEnvelope(text);
    const twice = stripArtifactEnvelope(once);
    expect(twice).toBe(once);
  });
});
