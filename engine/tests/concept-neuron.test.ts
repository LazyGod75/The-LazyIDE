/**
 * TDD tests for Task 4.2: concept-neuron composer.
 *
 * composeConceptNeuron(descriptor) → <article data-cerveau-type="concept" ...>
 */

import { describe, expect, it } from 'vitest';
import { composeConceptNeuron } from '../src/annotator/blocks/composers/concept-neuron.js';
import type { ConceptNeuronDescriptor } from '../src/annotator/blocks/composers/concept-neuron.js';
import { validateNote } from '../src/schema/validator.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_DESCRIPTOR: ConceptNeuronDescriptor = {
  id: 'concept:canonical-merge-rule',
  title: 'Canonical Merge Rule',
  kind: 'rule',
  body: 'When a knowledge item has >70% weight on a single neuron, it becomes a section of that neuron. Otherwise it becomes a standalone concept neuron.',
  confidence: 0.9,
  date: '2026-05-28',
  related: [
    { id: 'file:src/graph/canonical-merge.ts', title: 'canonical-merge.ts' },
    { id: 'file:src/annotator/blocks/composers/concept-neuron.ts', title: 'concept-neuron.ts' },
  ],
};

const FULL_DESCRIPTOR: ConceptNeuronDescriptor = {
  ...BASE_DESCRIPTOR,
  projectName: 'LazyBrain',
  supersededDate: '2027-01-01',
};

const MINIMAL_DESCRIPTOR: ConceptNeuronDescriptor = {
  id: 'concept:simple-idea',
  title: 'Simple Idea',
  kind: 'idea',
  body: 'A short idea.',
  confidence: 0.5,
  date: '2026-05-28',
  related: [],
};

// ---------------------------------------------------------------------------
// Root element and data-cerveau-type
// ---------------------------------------------------------------------------

describe('composeConceptNeuron — root element', () => {
  it('output starts with <article and ends with </article>', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    expect(html).toContain('<article');
    expect(html.trim()).toMatch(/<\/article>\s*$/);
  });

  it('has data-cerveau-type="concept"', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    expect(html).toContain('data-cerveau-type="concept"');
  });

  it('has data-cerveau-version="0.2.0"', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    expect(html).toContain('data-cerveau-version="0.2.0"');
  });

  it('has id starting with "concept-"', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    expect(html).toMatch(/id="concept-[^"]+"/);
  });

  it('id is at least 5 characters', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    const match = html.match(/id="([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Required schema attributes
// ---------------------------------------------------------------------------

describe('composeConceptNeuron — required schema attributes', () => {
  it('has data-cerveau-created', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    expect(html).toContain('data-cerveau-created=');
  });

  it('has data-cerveau-source', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    expect(html).toContain('data-cerveau-source=');
  });

  it('has data-cerveau-confidence matching the descriptor value', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    expect(html).toContain('data-cerveau-confidence="0.9"');
  });

  it('confidence is in [0,1] range (validator passes)', () => {
    const html = composeConceptNeuron({ ...BASE_DESCRIPTOR, confidence: 0.5 });
    const result = validateNote(html);
    const floatErrors = result.issues.filter((i) => i.code === 'OUT_OF_RANGE_FLOAT');
    expect(floatErrors).toHaveLength(0);
  });

  it('data-cerveau-created is a valid ISO date', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    const result = validateNote(html);
    const dateErrors = result.issues.filter((i) => i.code === 'INVALID_DATE');
    expect(dateErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// supersededDate → data-cerveau-valid-until
// ---------------------------------------------------------------------------

describe('composeConceptNeuron — supersededDate', () => {
  it('emits data-cerveau-valid-until when supersededDate is provided', () => {
    const html = composeConceptNeuron(FULL_DESCRIPTOR);
    expect(html).toContain('data-cerveau-valid-until="2027-01-01"');
  });

  it('does NOT emit data-cerveau-valid-until when supersededDate is absent', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    expect(html).not.toContain('data-cerveau-valid-until');
  });
});

// ---------------------------------------------------------------------------
// Infobox
// ---------------------------------------------------------------------------

describe('composeConceptNeuron — infobox', () => {
  it('contains an infobox', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    expect(html).toContain('class="infobox"');
  });

  it('infobox shows kind', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    expect(html).toContain('rule');
  });

  it('infobox shows confidence value', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    expect(html).toContain('0.9');
  });

  it('infobox shows date', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    expect(html).toContain('2026-05-28');
  });

  it('infobox shows "idea" kind for idea descriptor', () => {
    const html = composeConceptNeuron({ ...BASE_DESCRIPTOR, kind: 'idea' });
    expect(html).toContain('idea');
  });

  it('infobox shows "decision" kind', () => {
    const html = composeConceptNeuron({ ...BASE_DESCRIPTOR, kind: 'decision' });
    expect(html).toContain('decision');
  });
});

// ---------------------------------------------------------------------------
// Breadcrumb (conditional on projectName)
// ---------------------------------------------------------------------------

describe('composeConceptNeuron — breadcrumb', () => {
  it('renders breadcrumb when projectName is provided', () => {
    const html = composeConceptNeuron(FULL_DESCRIPTOR);
    expect(html).toContain('class="breadcrumb"');
  });

  it('breadcrumb contains project name', () => {
    const html = composeConceptNeuron(FULL_DESCRIPTOR);
    expect(html).toContain('LazyBrain');
  });

  it('breadcrumb contains concept title', () => {
    const html = composeConceptNeuron(FULL_DESCRIPTOR);
    expect(html).toContain('Canonical Merge Rule');
  });

  it('does NOT render breadcrumb when projectName is absent', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    expect(html).not.toContain('class="breadcrumb"');
  });
});

// ---------------------------------------------------------------------------
// Body content
// ---------------------------------------------------------------------------

describe('composeConceptNeuron — body content', () => {
  it('contains the body text', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    expect(html).toContain('When a knowledge item has');
  });

  it('body is HTML-escaped (< becomes &lt;)', () => {
    const html = composeConceptNeuron({
      ...BASE_DESCRIPTOR,
      body: 'Use <template> for code',
    });
    expect(html).toContain('&lt;template&gt;');
    expect(html).not.toContain('<template>');
  });

  it('title is present as h1', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    expect(html).toContain('<h1>');
    expect(html).toContain('Canonical Merge Rule');
  });
});

// ---------------------------------------------------------------------------
// Related links (navigation backbone)
// ---------------------------------------------------------------------------

describe('composeConceptNeuron — related links', () => {
  it('renders related section when related is non-empty', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    expect(html).toContain('data-section="related"');
  });

  it('related links use #/<id> href format', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    expect(html).toContain('href="#/file:src/graph/canonical-merge.ts"');
  });

  it('related links contain the title text', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    expect(html).toContain('canonical-merge.ts');
  });

  it('all related ids appear as links', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    for (const rel of BASE_DESCRIPTOR.related) {
      expect(html).toContain(`href="#/${rel.id}"`);
    }
  });

  it('related section absent when related is empty', () => {
    const html = composeConceptNeuron(MINIMAL_DESCRIPTOR);
    expect(html).not.toContain('data-section="related"');
  });
});

// ---------------------------------------------------------------------------
// TLDR section
// ---------------------------------------------------------------------------

describe('composeConceptNeuron — tldr section', () => {
  it('contains a tldr section', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    expect(html).toContain('data-section="tldr"');
  });

  it('tldr includes the kind', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    const tldrMatch = html.match(/<section data-section="tldr">([\s\S]*?)<\/section>/);
    expect(tldrMatch).not.toBeNull();
    expect(tldrMatch![1]).toContain('rule');
  });
});

// ---------------------------------------------------------------------------
// See-also (conditional)
// ---------------------------------------------------------------------------

describe('composeConceptNeuron — see-also', () => {
  it('renders see-also section when seeAlso links provided', () => {
    const html = composeConceptNeuron({
      ...BASE_DESCRIPTOR,
      seeAlso: [{ id: 'concept:another-concept', title: 'Another concept' }],
    });
    expect(html).toContain('data-section="see-also"');
    expect(html).toContain('concept:another-concept');
  });

  it('omits see-also when no seeAlso provided', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    expect(html).not.toContain('data-section="see-also"');
  });
});

// ---------------------------------------------------------------------------
// Schema validation (validateNote must pass with no errors, no INVALID_TYPE)
// ---------------------------------------------------------------------------

describe('composeConceptNeuron — schema validation', () => {
  it('passes validateNote with no errors for base descriptor', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    const result = validateNote(html);
    const errors = result.issues.filter((i) => i.level === 'error');
    expect(errors).toHaveLength(0);
  });

  it('passes validateNote with no errors for full descriptor (with supersededDate)', () => {
    const html = composeConceptNeuron(FULL_DESCRIPTOR);
    const result = validateNote(html);
    const errors = result.issues.filter((i) => i.level === 'error');
    expect(errors).toHaveLength(0);
  });

  it('passes validateNote with no errors for minimal descriptor', () => {
    const html = composeConceptNeuron(MINIMAL_DESCRIPTOR);
    const result = validateNote(html);
    const errors = result.issues.filter((i) => i.level === 'error');
    expect(errors).toHaveLength(0);
  });

  it('does NOT emit INVALID_TYPE warning (concept is a valid type)', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    const result = validateNote(html);
    const invalidType = result.issues.find((i) => i.code === 'INVALID_TYPE');
    expect(invalidType).toBeUndefined();
  });

  it('does NOT emit INVALID_TYPE warning for full descriptor', () => {
    const html = composeConceptNeuron(FULL_DESCRIPTOR);
    const result = validateNote(html);
    const invalidType = result.issues.find((i) => i.code === 'INVALID_TYPE');
    expect(invalidType).toBeUndefined();
  });

  it('validateNote returns ok=true for base descriptor', () => {
    const html = composeConceptNeuron(BASE_DESCRIPTOR);
    const result = validateNote(html);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// All 6 kind values are valid
// ---------------------------------------------------------------------------

describe('composeConceptNeuron — all kind values', () => {
  const kinds = ['decision', 'idea', 'fact', 'rule', 'qa', 'bug'] as const;

  for (const kind of kinds) {
    it(`kind="${kind}" produces valid HTML that passes schema validation`, () => {
      const html = composeConceptNeuron({ ...MINIMAL_DESCRIPTOR, kind });
      const result = validateNote(html);
      expect(result.ok).toBe(true);
    });
  }
});
