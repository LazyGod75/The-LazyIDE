# Wiki Tag Catalog

Comprehensive reference for semantic HTML elements in LazyBrain notes.
Covers: synthesis (`synthesize.ts`), templates (`template.ts` / dream-init),
styling (`wiki.css`), and strip behavior (`strip.ts`).

---

## How to read this catalog

Each entry follows this structure:

```
USE CASE: name
HTML:         exact element + attributes
CSS CLASS:    class name(s)
VISUAL:       rendering description
STRIP OUTPUT: what strip.ts produces for LLM consumption
QUERY:        CSS selector to retrieve these elements
STRIP STATUS: already-handled / needs-update
EXAMPLE:      concrete HTML snippet
```

---

## 1. Status Tracking

### 1.1 Feature completion status

```
USE CASE: Feature completion status
HTML:         <mark class="status-done|status-in-progress|status-planned|status-blocked"
                    data-cerveau-status="done|in-progress|planned|blocked">label</mark>
CSS CLASS:    status-done / status-in-progress / status-planned / status-blocked
VISUAL:       Inline colored badge — green (done), amber (in-progress),
              blue (planned), red (blocked)
STRIP OUTPUT: Falls through to inline text walk → emits label text as-is.
              Recommend adding a prefix in strip.ts walk() for <mark>:
                [DONE] / [IN-PROGRESS] / [PLANNED] / [BLOCKED]
              Currently emits raw label only.
QUERY:        mark[data-cerveau-status]
              mark.status-done
              mark.status-in-progress
              mark.status-planned
              mark.status-blocked
STRIP STATUS: needs-update — add <mark> handling in walk() to emit status prefix
EXAMPLE:
  <p>Navigation refactor
    <mark class="status-done" data-cerveau-status="done">done</mark>
  </p>
  <p>Dark mode support
    <mark class="status-planned" data-cerveau-status="planned">planned</mark>
  </p>
```

### 1.2 Bug status

```
USE CASE: Bug status
HTML:         <mark class="bug-open|bug-fixed|bug-wontfix"
                    data-cerveau-bug-status="open|fixed|wontfix"
                    data-cerveau-bug-id="BUG-123">label</mark>
CSS CLASS:    bug-open / bug-fixed / bug-wontfix
VISUAL:       Red (open), green strikethrough (fixed), gray (wontfix)
STRIP OUTPUT: [BUG:open] / [BUG:fixed] / [BUG:wontfix] — needs-update in walk()
QUERY:        mark[data-cerveau-bug-status]
              mark.bug-open
              mark.bug-fixed
STRIP STATUS: needs-update
EXAMPLE:
  <p>Crash on logout
    <mark class="bug-open" data-cerveau-bug-status="open" data-cerveau-bug-id="BUG-42">open</mark>
  </p>
```

### 1.3 Decision status

```
USE CASE: Decision status
HTML:         <aside role="doc-note" data-cerveau-decision-status="decided|exploring|reversed"
                    class="decision-block">
                <p class="decision-question">Should we use Zustand?</p>
                <p class="decision-outcome">No — TanStack Query covers all server state.</p>
              </aside>
CSS CLASS:    decision-block  decision-question  decision-outcome
VISUAL:       Left-bordered card — blue (exploring), green (decided), orange (reversed)
STRIP OUTPUT: strip.ts already handles aside[role="doc-note"] via the generic
              aside[role] branch → emits [WARNING]/[TIP]/etc.
              doc-note has no prefix defined → falls through to walk().
              Recommend: add 'doc-note' → '[DECISION]' in prefixMap.
QUERY:        aside[data-cerveau-decision-status]
              aside.decision-block[data-cerveau-decision-status="decided"]
STRIP STATUS: needs-update — add 'doc-note' to prefixMap in walk()
EXAMPLE:
  <aside role="doc-note" data-cerveau-decision-status="decided" class="decision-block">
    <p class="decision-question">SSR or CSR for the blog?</p>
    <p class="decision-outcome">SSR via Next.js App Router — SEO requirement.</p>
    <p class="decision-alternatives">Considered: SPA (rejected: poor Googlebot indexing)</p>
  </aside>
```

---

## 2. Temporal Data

### 2.1 Session summary (last N sessions)

```
USE CASE: Last N sessions summary
HTML:         <section data-cerveau-temporal="last-sessions"
                       data-cerveau-session-count="3">
                <h3>Last 3 sessions</h3>
                <ul>
                  <li><time datetime="2026-05-24">24 May</time> — fixed auth bug</li>
                </ul>
              </section>
CSS CLASS:    (none required — uses data attribute)
VISUAL:       Collapsible timeline block with session count badge
STRIP OUTPUT: <section> → already emits [section-name] marker when
              data-section is set. Use data-section="last-sessions" for consistency.
              <time> elements → emits textContent (datetime= is only special for
              ISO duration P\d+D format).
QUERY:        section[data-cerveau-temporal="last-sessions"]
              section[data-section="last-sessions"]
STRIP STATUS: already-handled (section + time walk)
EXAMPLE:
  <section data-section="last-sessions" data-cerveau-temporal="last-sessions"
           data-cerveau-session-count="3">
    <h3>Last 3 sessions</h3>
    <ul>
      <li><time datetime="2026-05-24">24 May</time> — auth refactor complete</li>
      <li><time datetime="2026-05-23">23 May</time> — RLS policies reviewed</li>
    </ul>
  </section>
```

### 2.2 Valid-until / deprecated info

```
USE CASE: Valid-until date (deprecated information)
HTML:         <del data-cerveau-valid-until="2026-06-01"
                   data-cerveau-replaced-by="new-note-id"
                   class="deprecated-info">deprecated content</del>
CSS CLASS:    deprecated-info
VISUAL:       Strikethrough text + amber "Deprecated until DATE" badge
STRIP OUTPUT: <del> is not in BLOCK_TAGS, not explicitly handled → falls through
              to walk(), emits textContent only.
              data-cerveau-valid-until on root article → already read by stripNote().
              For inline <del>, needs-update: emit "[DEPRECATED] " prefix in walk().
QUERY:        del[data-cerveau-valid-until]
              del.deprecated-info
              article[data-cerveau-valid-until]
STRIP STATUS: needs-update for inline <del>; root-level valid_until already handled
EXAMPLE:
  <p>Use <del class="deprecated-info" data-cerveau-valid-until="2026-07-01">
    expo-av for audio
  </del> — replaced by expo-audio since SDK 53.</p>
```

### 2.3 Timeline of events

```
USE CASE: Timeline of events
HTML:         <ol class="event-timeline">
                <li data-cerveau-date="2026-05-01">
                  <time datetime="2026-05-01">1 May 2026</time>
                  <span class="event-label">Phase 1 launched</span>
                </li>
              </ol>
CSS CLASS:    event-timeline  event-label
VISUAL:       Vertical timeline with dot markers and date labels
STRIP OUTPUT: <ol>/<li> → already handled via LIST_ITEM_TAGS → emits "\n- item"
              <time> textContent emitted inline
QUERY:        ol.event-timeline li
              ol.event-timeline li[data-cerveau-date]
STRIP STATUS: already-handled
EXAMPLE:
  <ol class="event-timeline">
    <li data-cerveau-date="2026-03-01">
      <time datetime="2026-03-01">March 2026</time>
      <span class="event-label">Acme v1.0 submitted to App Store</span>
    </li>
    <li data-cerveau-date="2026-05-10">
      <time datetime="2026-05-10">May 2026</time>
      <span class="event-label">AdminPanel Phase 2 shipped</span>
    </li>
  </ol>
```

---

## 3. Technical Specs

### 3.1 API endpoints

```
USE CASE: API endpoint with HTTP method
HTML:         <code class="api-endpoint" data-cerveau-method="GET|POST|PUT|DELETE|PATCH"
                    data-cerveau-path="/api/users/{id}">GET /api/users/{id}</code>
CSS CLASS:    api-endpoint  http-get / http-post / http-put / http-delete / http-patch
VISUAL:       Pill badge for method (color-coded) + monospace path
STRIP OUTPUT: <code> is not in BLOCK_TAGS → falls to walk() → emits textContent.
              Sufficient: "GET /api/users/{id}" is readable as-is by LLM.
QUERY:        code.api-endpoint
              code[data-cerveau-method="POST"]
STRIP STATUS: already-handled (textContent sufficient)
EXAMPLE:
  <ul>
    <li><code class="api-endpoint http-post" data-cerveau-method="POST"
              data-cerveau-path="/api/contact">POST /api/contact</code>
        — Zod-validated contact form submission</li>
    <li><code class="api-endpoint http-get" data-cerveau-method="GET"
              data-cerveau-path="/api/og">GET /api/og</code>
        — Dynamic OpenGraph image generation</li>
  </ul>
```

### 3.2 Database tables

```
USE CASE: Database table with columns
HTML:         <table class="db-schema" data-cerveau-table="table_name">
                <caption>table_name</caption>
                <thead>
                  <tr><th>column</th><th>type</th><th>notes</th></tr>
                </thead>
                <tbody>
                  <tr><td>id</td><td>uuid</td><td>PK, gen_random_uuid()</td></tr>
                </tbody>
              </table>
CSS CLASS:    db-schema
VISUAL:       Compact table with monospace column names, type badges
STRIP OUTPUT: <table> → BLOCK_TAGS → emits \n before/after.
              <tr> → BLOCK_TAGS → emits \n before/after.
              <td>/<th> → not in BLOCK_TAGS → walk() inline text.
              Result: readable columnar text for LLM.
QUERY:        table.db-schema
              table[data-cerveau-table]
STRIP STATUS: already-handled
EXAMPLE:
  <table class="db-schema" data-cerveau-table="workout_sessions">
    <caption>workout_sessions</caption>
    <thead><tr><th>column</th><th>type</th><th>constraint</th></tr></thead>
    <tbody>
      <tr><td>id</td><td>uuid</td><td>PK default gen_random_uuid()</td></tr>
      <tr><td>user_id</td><td>uuid</td><td>FK profiles.id, NOT NULL</td></tr>
      <tr><td>exercises</td><td>jsonb</td><td>muscle/machine/sets array</td></tr>
    </tbody>
  </table>
```

### 3.3 Environment variables

```
USE CASE: Environment variable with description
HTML:         <dl class="env-vars">
                <dt><var class="env-var">SUPABASE_URL</var></dt>
                <dd>Supabase project URL — required at startup</dd>
              </dl>
CSS CLASS:    env-vars  env-var
VISUAL:       Definition list with monospace var names, description inline
STRIP OUTPUT: <dl>/<dt>/<dd> → dt is in BLOCK_TAGS (as LIST_ITEM_TAGS) → "\n- "
              <var> → not handled → walk() → textContent.
              Sufficient for LLM.
QUERY:        dl.env-vars dt var.env-var
              var.env-var
STRIP STATUS: already-handled (textContent walk sufficient)
EXAMPLE:
  <dl class="env-vars">
    <dt><var class="env-var">NEXT_PUBLIC_SUPABASE_URL</var></dt>
    <dd>Supabase project URL, exposed to browser</dd>
    <dt><var class="env-var">STRIPE_WEBHOOK_SECRET</var></dt>
    <dd>Stripe webhook signing secret — server-side only</dd>
  </dl>
```

### 3.4 CLI commands

```
USE CASE: CLI command with example output
HTML:         <figure class="cli-example">
                <figcaption>Run dev server</figcaption>
                <kbd>npx expo start --tunnel</kbd>
                <samp>› Metro bundler ready on port 8081</samp>
              </figure>
CSS CLASS:    cli-example
VISUAL:       Terminal-style block — dark background, monospace,
              kbd styled as keypress, samp as output
STRIP OUTPUT: <figure> → BLOCK_TAGS → \n wrapper.
              <kbd> → already styled in enrichHtmlContent() but not in strip walk()
                    → falls to walk() → emits textContent.
              <samp> → already styled in enrichHtmlContent() → in walk() falls
                       through to walk() → emits textContent.
              <figcaption> → BLOCK_TAGS → \n + text.
              Sufficient for LLM.
QUERY:        figure.cli-example kbd
              figure.cli-example samp
STRIP STATUS: already-handled
EXAMPLE:
  <figure class="cli-example">
    <figcaption>Apply Supabase migrations</figcaption>
    <kbd>supabase db push</kbd>
    <samp>Applying migration 20260501000000_admin_views.sql... done</samp>
  </figure>
```

### 3.5 File paths linking to code

```
USE CASE: File path that links to source code
HTML:         <data class="file-path" value="src/commands/synthesize.ts">synthesize.ts</data>
CSS CLASS:    file-path
VISUAL:       Monospace text with subtle underline, links to code view on click
STRIP OUTPUT: <data value="..."> → already handled in strip.ts walk():
              emits value + " " then walks children.
              Result: "src/commands/synthesize.ts synthesize.ts" — slightly redundant
              but complete.
              Alternative form: <a href="#/file/src/commands/synthesize.ts">synthesize.ts</a>
              would emit [synthesize.ts→#/file/...].
QUERY:        data.file-path[value]
STRIP STATUS: already-handled
EXAMPLE:
  <p>NutritionEngine logic is in
    <data class="file-path" value="acme-app/lib/services/nutritionEngine.js">nutritionEngine.js</data>
    — pure functions, no Supabase calls.
  </p>
```

---

## 4. Knowledge Types

### 4.1 Bug with root cause and fix

```
USE CASE: Bug with root cause and fix
HTML:         <aside role="doc-errata" class="bug-record"
                     data-cerveau-bug-id="BUG-42"
                     data-cerveau-bug-status="fixed">
                <p class="bug-symptom"><strong>Symptom:</strong> app crashes on logout</p>
                <p class="bug-cause"><strong>Root cause:</strong> AsyncStorage cleared before
                  Supabase session.signOut() resolved</p>
                <p class="bug-fix"><strong>Fix:</strong> await signOut() before clearing storage</p>
              </aside>
CSS CLASS:    bug-record  bug-symptom  bug-cause  bug-fix
VISUAL:       Red-bordered card (open), green-bordered (fixed), with structured sections
STRIP OUTPUT: aside[role="doc-errata"] → already handled in strip.ts prefixMap
              → emits "[ERRATA] " + content walk.
              All child <p> content emitted via walk().
QUERY:        aside[role="doc-errata"].bug-record
              aside.bug-record[data-cerveau-bug-status="open"]
STRIP STATUS: already-handled
EXAMPLE:
  <aside role="doc-errata" class="bug-record" data-cerveau-bug-id="BUG-07"
         data-cerveau-bug-status="fixed">
    <p class="bug-symptom"><strong>Symptom:</strong> 60 seeds marked enriched but unavailable</p>
    <p class="bug-cause"><strong>Root cause:</strong> enrich_slide_details wrote to seed DB
      only, not bank DB used by daily_cron</p>
    <p class="bug-fix"><strong>Fix:</strong> manual sync script + dual-write in pipeline</p>
  </aside>
```

### 4.2 Decision with reasoning

```
USE CASE: Decision with reasoning and alternatives
HTML:         <aside role="doc-note" class="decision-record"
                     data-cerveau-decision-status="decided"
                     data-cerveau-decision-id="DEC-12">
                <p class="decision-question"><strong>Question:</strong> Which state manager?</p>
                <p class="decision-outcome"><strong>Decision:</strong> TanStack Query v5</p>
                <p class="decision-reasoning"><strong>Reasoning:</strong> server state only;
                  no need for global client state beyond Context</p>
                <p class="decision-alternatives"><strong>Rejected:</strong> Redux (too heavy),
                  Zustand (no cache invalidation)</p>
              </aside>
CSS CLASS:    decision-record  decision-question  decision-outcome
              decision-reasoning  decision-alternatives
VISUAL:       Blue card (exploring), green (decided), orange (reversed)
STRIP OUTPUT: aside[role="doc-note"] → currently falls to generic walk() (no prefix).
              Needs-update: add 'doc-note' → '[DECISION]' in prefixMap.
QUERY:        aside.decision-record[data-cerveau-decision-status]
STRIP STATUS: needs-update (add doc-note prefix)
EXAMPLE: see section 1.3 above
```

### 4.3 Ideas for the future

```
USE CASE: Future idea / backlog item
HTML:         <aside role="doc-tip" class="idea-note"
                     data-cerveau-idea-horizon="short|medium|long">
                <p>Idea: add voice-to-text for meal logging using Whisper API</p>
              </aside>
CSS CLASS:    idea-note
VISUAL:       Teal left-border card with lightbulb icon (already injected by enrichHtmlContent)
STRIP OUTPUT: aside[role="doc-tip"] → already handled → emits "[TIP] " + content.
QUERY:        aside[role="doc-tip"].idea-note
              aside.idea-note[data-cerveau-idea-horizon="short"]
STRIP STATUS: already-handled
EXAMPLE:
  <aside role="doc-tip" class="idea-note" data-cerveau-idea-horizon="medium">
    <p>Idea: weekly coaching digest email — summary of student progress
      sent every Sunday at 08:00 via Supabase Edge Function + Resend.</p>
  </aside>
```

### 4.4 Anti-patterns

```
USE CASE: Anti-pattern (things to NEVER do)
HTML:         <aside role="doc-warning" class="antipattern"
                     data-cerveau-antipattern="true">
                <p><strong>NEVER:</strong> call Supabase directly from UI components.
                  Always go through <code>database/</code> helpers.</p>
              </aside>
CSS CLASS:    antipattern
VISUAL:       Red card with warning icon (injected by enrichHtmlContent)
STRIP OUTPUT: aside[role="doc-warning"] → already handled → emits "[WARNING] " + content.
QUERY:        aside[role="doc-warning"].antipattern
              aside[data-cerveau-antipattern]
STRIP STATUS: already-handled
EXAMPLE:
  <aside role="doc-warning" class="antipattern" data-cerveau-antipattern="true">
    <p><strong>NEVER:</strong> expose SUPABASE_SERVICE_ROLE_KEY client-side.
      All writes via Edge Functions only.</p>
  </aside>
```

### 4.5 Best practices

```
USE CASE: Best practice (things to ALWAYS do)
HTML:         <aside role="doc-tip" class="best-practice"
                     data-cerveau-practice="true">
                <p><strong>ALWAYS:</strong> validate Stripe webhook signature
                  before processing any event.</p>
              </aside>
CSS CLASS:    best-practice
VISUAL:       Green card with checkmark icon
STRIP OUTPUT: aside[role="doc-tip"] → already handled → emits "[TIP] " + content.
QUERY:        aside[role="doc-tip"].best-practice
              aside[data-cerveau-practice]
STRIP STATUS: already-handled
EXAMPLE:
  <aside role="doc-tip" class="best-practice" data-cerveau-practice="true">
    <p><strong>ALWAYS:</strong> parameterize SQL queries — no string interpolation
      in Supabase RPC args.</p>
  </aside>
```

### 4.6 Comparisons

```
USE CASE: Comparison — option A vs option B
HTML:         <table class="comparison-table"
                      data-cerveau-option-a="Expo Router"
                      data-cerveau-option-b="React Navigation"
                      data-cerveau-winner="expo-router">
                <thead>
                  <tr><th>Criteria</th><th>Expo Router</th><th>React Navigation</th></tr>
                </thead>
                <tbody>
                  <tr><td>File-based routing</td><td>Yes</td><td>No</td></tr>
                  <tr><td>Deep linking</td><td>Auto</td><td>Manual config</td></tr>
                </tbody>
              </table>
CSS CLASS:    comparison-table
VISUAL:       Side-by-side table, winner column highlighted in green
STRIP OUTPUT: <table> → BLOCK_TAGS → block-level formatting.
              All cells emitted inline via walk(). LLM can parse comparison structure.
QUERY:        table.comparison-table
              table[data-cerveau-winner]
STRIP STATUS: already-handled
EXAMPLE: see HTML above
```

### 4.7 Dependencies between features

```
USE CASE: Dependency relationship between features/modules
HTML:         <p>The nutrition adaptive engine
                <a href="#/note/acme-nutrition-engine"
                   data-cerveau-link-type="depends-on"
                   rel="depends-on">depends on</a>
                the workout session data for PAL calculation.
              </p>
CSS CLASS:    (no special class — uses rel= on <a>)
VISUAL:       Styled link with dependency badge (arrow icon)
STRIP OUTPUT: <a href="#..." rel="depends-on"> → already handled by strip.ts walk():
              href starts with '#' AND rel is present
              → emits "[term→#id|depends-on]"
QUERY:        a[rel="depends-on"]
              a[data-cerveau-link-type="depends-on"]
STRIP STATUS: already-handled
EXAMPLE:
  <p>The
    <a href="#/note/acme-payments-stripe" data-cerveau-link-type="depends-on"
       rel="depends-on">Stripe webhook handler</a>
    depends on the suivis_achetes table schema.
  </p>
```

---

## 5. Relationships

### 5.1 This replaces X

```
USE CASE: Replacement relationship ("this replaces X")
HTML:         article[data-cerveau-replaces="old-note-id,other-old-note-id"]
              — on the root <article> element
CSS CLASS:    (attribute on root article, not a class)
VISUAL:       Header badge "Replaces: [old-note-title]"
STRIP OUTPUT: stripNote() already reads data-cerveau-replaces from root article
              → stored in StrippedNote.replaces.
              stripNoteToPrompt() already emits "↺old-note-id" in relation line.
QUERY:        article[data-cerveau-replaces]
STRIP STATUS: already-handled
EXAMPLE:
  <article id="acme-mobile-arch-v2"
           data-cerveau-replaces="acme-mobile-arch"
           data-cerveau-version="0.2.0" ...>
    <!-- new version of mobile architecture note -->
  </article>
```

### 5.2 Depends on Y

```
USE CASE: Explicit dependency (node-level, not inline link)
HTML:         article[data-cerveau-triples="feature|depends-on|other-feature"]
CSS CLASS:    (attribute on root article)
VISUAL:       Rendered in infobox or relationships section
STRIP OUTPUT: stripNote() reads data-cerveau-triples → stored in StrippedNote.triples.
              stripNoteToPrompt() emits "◦subj|pred|obj" in relation line.
QUERY:        article[data-cerveau-triples]
STRIP STATUS: already-handled
EXAMPLE:
  <article id="acme-nutrition-engine"
           data-cerveau-triples="nutrition-engine|depends-on|workout_sessions;nutrition-engine|depends-on|profiles"
           ...>
```

### 5.3 Related to Z

```
USE CASE: Related note (soft association)
HTML:         <a href="#/note/related-note-id"
                 data-cerveau-link-type="see-also"
                 rel="see-also">Related concept</a>
CSS CLASS:    wiki-link  (added by convertInternalLinks)
VISUAL:       Styled wikilink with "see also" indicator
STRIP OUTPUT: <a href="#..." rel="see-also"> → walk() emits "[term→#id|see-also]"
              Also captured by extractWikilinks() into StrippedNote.wikilinks.
QUERY:        a[data-cerveau-link-type="see-also"]
              a[rel="see-also"]
STRIP STATUS: already-handled
EXAMPLE:
  <p>See also:
    <a href="#/note/acme-supabase-schema" data-cerveau-link-type="see-also"
       rel="see-also">Supabase Schema</a>
  </p>
```

### 5.4 Contradicts W

```
USE CASE: Contradiction between two notes/facts
HTML:         <a href="#/note/contradicted-note-id"
                 data-cerveau-link-type="contradicts"
                 rel="contradicts"
                 class="wiki-link contradiction-link">contradicts this note</a>
CSS CLASS:    contradiction-link
VISUAL:       Red strikethrough-style link with warning badge
STRIP OUTPUT: <a href="#..." rel="contradicts"> → walk() emits "[term→#id|contradicts]"
QUERY:        a[rel="contradicts"]
              a.contradiction-link
STRIP STATUS: already-handled (rel= branch in walk())
EXAMPLE:
  <p>This decision
    <a href="#/note/dec-old-redux" rel="contradicts"
       data-cerveau-link-type="contradicts"
       class="wiki-link contradiction-link">contradicts the 2024 Redux decision</a>.
  </p>
```

---

## 6. Data Visualization

### 6.1 Metric cards

```
USE CASE: Metric card (number + label + trend)
HTML:         <figure class="metric-card"
                       data-cerveau-metric="dau"
                       data-cerveau-value="47"
                       data-cerveau-trend="up|down|stable"
                       data-cerveau-delta="+12%">
                <figcaption>DAU</figcaption>
                <data value="47" class="metric-value">47</data>
                <span class="metric-trend trend-up">+12%</span>
              </figure>
CSS CLASS:    metric-card  metric-value  metric-trend  trend-up / trend-down / trend-stable
VISUAL:       Card with large number, label, and colored trend arrow
STRIP OUTPUT: <figure> → BLOCK_TAGS → \n wrapper.
              <figcaption> → BLOCK_TAGS → emits label.
              <data value="47"> → walk() emits "47 47" (value + textContent — slightly
              redundant but acceptable).
              <span> → walk() inline text → emits "+12%"
              Result: "DAU\n47 47\n+12%" — LLM-readable.
QUERY:        figure.metric-card
              figure[data-cerveau-metric]
STRIP STATUS: already-handled (minor redundancy in data element acceptable)
EXAMPLE:
  <figure class="metric-card" data-cerveau-metric="mrr"
          data-cerveau-value="1240" data-cerveau-trend="up" data-cerveau-delta="+8%">
    <figcaption>MRR</figcaption>
    <data value="1240" class="metric-value">1 240 €</data>
    <span class="metric-trend trend-up">+8%</span>
  </figure>
```

### 6.2 Progress indicators

```
USE CASE: Progress indicator
HTML:         <figure class="progress-indicator">
                <figcaption>Phase 2 — Engagement</figcaption>
                <meter class="progress-bar"
                       value="0.65" min="0" max="1"
                       data-cerveau-progress="65"
                       title="65% complete">65%</meter>
              </figure>
CSS CLASS:    progress-indicator  progress-bar
VISUAL:       Native <meter> styled with CSS, label above
STRIP OUTPUT: <meter value="0.65"> → already handled in strip.ts walk():
              emits "0.65 conf" — slightly confusing ("conf" = confidence for <meter>).
              For progress context, the label "65%" inside meter is also emitted
              via fallback. Consider: add data-cerveau-progress attribute handling
              to emit "65% done" instead.
QUERY:        meter.progress-bar[data-cerveau-progress]
              figure.progress-indicator meter
STRIP STATUS: needs-update — meter emits "conf" but context is progress, not confidence.
              Add data-cerveau-progress attribute check in walk() before generic meter.
EXAMPLE:
  <figure class="progress-indicator">
    <figcaption>AdminPanel Phase 2</figcaption>
    <meter value="0.65" min="0" max="1" data-cerveau-progress="65"
           class="progress-bar" title="65% complete">65%</meter>
  </figure>
```

### 6.3 Confidence levels

```
USE CASE: Confidence level (for facts and claims)
HTML:         <meter class="confidence-meter"
                     value="0.85" min="0" max="1"
                     data-cerveau-confidence="0.85">0.85</meter>
CSS CLASS:    confidence-meter
VISUAL:       Small colored bar — green (>0.8), amber (0.5-0.8), red (<0.5)
STRIP OUTPUT: <meter value="0.85"> → already handled → emits "0.85 conf"
              This is the intended use case for strip.ts meter handling.
QUERY:        meter.confidence-meter[data-cerveau-confidence]
              [data-cerveau-confidence]
STRIP STATUS: already-handled
EXAMPLE:
  <p>The DAU calculation uses union of 6 tables
    <meter class="confidence-meter" value="0.95"
           data-cerveau-confidence="0.95">0.95</meter>
  </p>
```

### 6.4 Comparison tables (structured)

```
USE CASE: Comparison table (see section 4.6)
— Covered in section 4.6 above. No additional definition needed.
```

---

## 7. Needed strip.ts Updates

The following changes are required in `src/retrieval/strip.ts`:

### 7.1 Add `<mark>` handling in `walk()`

```typescript
} else if (tag === 'mark') {
  const status = el.getAttribute('data-cerveau-status');
  const bugStatus = el.getAttribute('data-cerveau-bug-status');
  if (status) {
    out.push(`[${status.toUpperCase()}] `);
  } else if (bugStatus) {
    out.push(`[BUG:${bugStatus}] `);
  }
  walk(el, out);
```

### 7.2 Add `doc-note` to `prefixMap` in `walk()`

```typescript
const prefixMap: Record<string, string> = {
  'doc-tip': '[TIP]',
  'doc-warning': '[WARNING]',
  'doc-example': '[EXAMPLE]',
  'doc-errata': '[ERRATA]',
  'doc-note': '[DECISION]',   // ADD THIS LINE
};
```

### 7.3 Add `<del>` handling for inline deprecated content

```typescript
} else if (tag === 'del') {
  const until = el.getAttribute('data-cerveau-valid-until');
  if (until) {
    out.push(`[DEPRECATED until ${until}] `);
  } else {
    out.push('[DEPRECATED] ');
  }
  walk(el, out);
```

### 7.4 Add `data-cerveau-progress` check for `<meter>`

```typescript
} else if (tag === 'meter') {
  const progress = el.getAttribute('data-cerveau-progress');
  if (progress) {
    out.push(`${progress}% done`);
  } else {
    const value = el.getAttribute('value') ?? '';
    out.push(value ? `${value} conf` : (el.textContent ?? '').trim());
  }
```

---

## 7b. Provenance (multi-agent)

Five attributes on the root `<article>` element record where and how a note was produced.
They are emitted by `emitWikipediaNote` (template.ts) and survive the public scrubber.

| Attribute | Encodes | CSS query example |
|---|---|---|
| `data-cerveau-agent` | Producing agent — `claude-code` or `vibe` | `article[data-cerveau-agent="vibe"]` |
| `data-cerveau-source-kind` | Conversation kind — `transcript`, `subagent`, `plan`, `history`, `compaction-summary` | `article[data-cerveau-source-kind="plan"]` |
| `data-cerveau-session-parent` | Parent session id for compaction lineage (Vibe only) | `article[data-cerveau-session-parent]` |
| `data-cerveau-git-commit` | Git commit hash at session start | `article[data-cerveau-git-commit^="deadbeef"]` |
| `data-cerveau-git-branch` | Git branch at session start | `article[data-cerveau-git-branch="main"]` |

All five attributes are allowlisted in `PUBLIC_SAFE_ATTRS` (`src/schema/scrubber.ts`).
They are omitted when the corresponding fields are not provided (claude-code path unchanged).

---

## 8. CSS Selector Quick Reference

| Use Case | Query Selector |
|---|---|
| All status marks | `mark[data-cerveau-status]` |
| Done features | `mark.status-done` |
| Blocked features | `mark.status-blocked` |
| Open bugs | `mark.bug-open` |
| Decided decisions | `aside[data-cerveau-decision-status="decided"]` |
| Reversed decisions | `aside[data-cerveau-decision-status="reversed"]` |
| Bug records (any) | `aside[role="doc-errata"].bug-record` |
| Open bugs (records) | `aside.bug-record[data-cerveau-bug-status="open"]` |
| Anti-patterns | `aside[role="doc-warning"].antipattern` |
| Best practices | `aside[role="doc-tip"].best-practice` |
| Ideas (short horizon) | `aside.idea-note[data-cerveau-idea-horizon="short"]` |
| API endpoints | `code.api-endpoint` |
| POST endpoints | `code[data-cerveau-method="POST"]` |
| DB schemas | `table.db-schema` |
| DB table by name | `table[data-cerveau-table="workout_sessions"]` |
| Env vars | `dl.env-vars dt var.env-var` |
| CLI commands | `figure.cli-example kbd` |
| File paths | `data.file-path[value]` |
| Deprecated (inline) | `del[data-cerveau-valid-until]` |
| Deprecated (root) | `article[data-cerveau-valid-until]` |
| Replaced notes | `article[data-cerveau-replaces]` |
| Dependencies (triple) | `article[data-cerveau-triples]` |
| Depends-on links | `a[rel="depends-on"]` |
| See-also links | `a[data-cerveau-link-type="see-also"]` |
| Contradictions | `a[rel="contradicts"]` |
| Metric cards | `figure.metric-card` |
| Progress indicators | `figure.progress-indicator meter` |
| Confidence levels | `meter.confidence-meter` |
| Comparison tables | `table.comparison-table` |
| Event timelines | `ol.event-timeline li` |
| Last sessions | `section[data-cerveau-temporal="last-sessions"]` |

---

## 9. Files to Update

| File | What to add |
|---|---|
| `src/commands/synthesize.ts` | Generate `mark[data-cerveau-status]`, `aside.decision-record`, `aside.bug-record`, `figure.metric-card`, `table.db-schema`, `code.api-endpoint`, `ol.event-timeline` |
| `src/annotator/template.ts` | Include boilerplate for status marks, decision blocks, bug records in new note templates |
| `examples/brain-ui/styles/wiki.css` | Style `.status-done`, `.status-in-progress`, `.status-planned`, `.status-blocked`, `.bug-open`, `.bug-fixed`, `.decision-block`, `.metric-card`, `.progress-indicator`, `.comparison-table`, `.event-timeline`, `.antipattern`, `.best-practice`, `.idea-note` |
| `src/retrieval/strip.ts` | 4 targeted updates — see section 7 above |

---

*Generated 2026-05-26 for LazyBrain feat/wiki-enrichment branch.*
