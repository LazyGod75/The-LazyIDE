/* wikiData.test.ts — parsers behind the Brain Wiki platform methods.

   Locks the shapes the Wiki view depends on against fixtures modelled on the
   real engine routes:
   - /_api/tree         → engine/src/server/routes/tree.ts (buildTree)
   - /_api/synthesis/*  → engine/src/annotator/blocks/composers/brain-index.ts

   Also checks the web platform mock returns valid, non-crashing shapes so the
   browser demo + the rest of the suite never depend on a live sidecar. */

import { describe, it, expect } from 'vitest';
import { parseTree, parseSynthesisPages, extractPageTitle } from '../lib/brain/wikiData';
import { WebPlatform } from '../lib/platform/web';

// A /_api/tree payload shaped exactly like engine buildTree's output.
const TREE_FIXTURE = {
  projects: [
    {
      id: 'agg-lazy',
      label: 'lazy',
      noteId: 'agg-lazy',
      type: 'project',
      children: [
        {
          id: 'agg-editor',
          label: 'editor',
          noteId: 'agg-editor',
          type: 'aggregate-neuron',
          children: [
            { id: 'n-auth', label: 'auth.ts', noteId: 'n-auth', type: 'file-neuron', children: [] },
          ],
        },
      ],
    },
  ],
};

// A brain-index article shaped like composeBrainIndex's output — note the
// duplicate #/editor link (must dedup) and the see-also `#/misc` link.
const BRAIN_INDEX_FIXTURE = `<article data-cerveau-type="brain-index">
<header class="wiki-header"><h1>My brain</h1></header>
<section id="topics"><h2>Topics</h2>
<section class="wiki-section" id="project-editor"><h2><a href="#/editor" class="section-link">editor</a></h2></section>
<section class="wiki-section" id="project-brain"><h2><a href="#/brain" class="section-link">brain</a></h2></section>
<section class="wiki-section" id="project-editor-dup"><h2><a href="#/editor" class="section-link">editor again</a></h2></section>
</section>
<section data-section="see-also"><h2>See also</h2><ul><li><a href="#/misc" class="section-link">misc</a></li></ul></section>
</article>`;

describe('parseTree', () => {
  it('parses the engine /_api/tree shape into a typed hierarchy', () => {
    const tree = parseTree(TREE_FIXTURE);
    expect(tree.projects).toHaveLength(1);
    const project = tree.projects[0];
    expect(project).toMatchObject({ id: 'agg-lazy', label: 'lazy', noteId: 'agg-lazy', type: 'project' });
    expect(project.children).toHaveLength(1);
    const module = project.children[0];
    expect(module).toMatchObject({ label: 'editor', type: 'aggregate-neuron', noteId: 'agg-editor' });
    expect(module.children[0]).toMatchObject({ label: 'auth.ts', noteId: 'n-auth', type: 'file-neuron' });
    expect(module.children[0].children).toEqual([]);
  });

  it('is defensive: malformed / missing input yields an empty tree, never throws', () => {
    expect(parseTree(null).projects).toEqual([]);
    expect(parseTree(undefined).projects).toEqual([]);
    expect(parseTree('nope').projects).toEqual([]);
    expect(parseTree({}).projects).toEqual([]);
    expect(parseTree({ projects: 'x' }).projects).toEqual([]);
    // A node missing an id is dropped; children default to [].
    const partial = parseTree({ projects: [{ label: 'no-id' }, { id: 'ok' }] });
    expect(partial.projects).toHaveLength(1);
    expect(partial.projects[0]).toMatchObject({ id: 'ok', label: 'ok', noteId: null, type: null, children: [] });
  });
});

describe('parseSynthesisPages', () => {
  it('extracts #/{slug} wiki links, deduped and order-preserving', () => {
    const pages = parseSynthesisPages(BRAIN_INDEX_FIXTURE);
    expect(pages).toEqual([
      { slug: 'editor', title: 'editor' },
      { slug: 'brain', title: 'brain' },
      { slug: 'misc', title: 'misc' },
    ]);
  });

  it('returns [] when a page has no wiki links', () => {
    expect(parseSynthesisPages('<article><p>no links here</p></article>')).toEqual([]);
  });
});

describe('extractPageTitle', () => {
  it('returns the first <h1> text', () => {
    expect(extractPageTitle(BRAIN_INDEX_FIXTURE, 'fallback')).toBe('My brain');
  });

  it('falls back when there is no <h1>', () => {
    expect(extractPageTitle('<article><p>x</p></article>', 'Overview')).toBe('Overview');
  });
});

describe('web platform brain wiki — no mock vault', () => {
  it('tree() is empty without a sidecar', async () => {
    const tree = await WebPlatform.brain.tree();
    expect(tree.projects).toEqual([]);
  });

  it('synthesisIndex() is null without a sidecar', async () => {
    expect(await WebPlatform.brain.synthesisIndex()).toBeNull();
  });

  it('synthesisTopic() is null without a sidecar', async () => {
    expect(await WebPlatform.brain.synthesisTopic('auth')).toBeNull();
  });
});
