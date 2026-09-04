# Team Brain — 2-machine demo script

This document describes the 2-machine demo scenario for the Team Brain feature,
covering all 12 acceptance criteria from the plan's section 9.

## Setup

### Machine A — Alice (org admin, rich solo brain)

- Lazy desktop app installed and signed in (Supabase).
- Has a rich solo brain: GameOn project scanned (code-scanner produced
  file-neurons for `src/`), plus manual decisions and bugs captured from
  past conversations.
- GitHub connected via the OAuth device flow (Settings → GitHub).
- No org membership yet (SoloView shows in the Team space).

### Machine B — Henry (team member, local GameOn history)

- Lazy desktop app installed and signed in (Supabase, different account).
- Has a local solo brain with GameOn conversation history (episodic notes).
- GitHub NOT connected yet.
- No org membership yet.

### Machine C (optional) — Claire (fresh install)

- Lazy desktop app installed, signed in.
- Empty brain (no scans, no captures).
- No org membership, no GitHub connection.

## Step-by-step demo

### Step 1 — Alice publishes her brain as the team brain (criterion 1)

1. Alice opens the **Team** space (Team pill in the top nav).
2. SoloView renders (no org yet). Alice clicks **Create a team**.
3. Alice names the org "Acme" and invites Henry by email.
4. After org creation, Alice clicks **Publish my brain as team brain**.
5. **Expected**: `publishExistingBrainAsTeam` runs:
   - Archives the current solo brain to `archives/<userId>/<timestamp>/`.
   - Provisions a private GitHub repo `acme/lazy-brain` via the REST API.
   - Pushes the EXISTING brain path (not a new empty dir) via
     `teams_push_repo`.
   - Calls `setBrainRepo` to persist the URL server-side.
   - Writes `active.json` pointing at the existing brain path.
6. **Verify**: The org's `brain_repo_url` is set in Supabase. Alice's brain
   is now the team brain (custom mode, same path).

### Step 2 — Alice's captures are attributed (criterion 2)

1. Alice captures a decision in a conversation (plan mode).
2. **Expected**: The note carries `data-cerveau-author="Alice"` and
   `data-cerveau-author-id="<alice-uuid>"` on the article and each fact
   paragraph.
3. **Verify**: Open the neuron in the Brain space — the author is visible.

### Step 3 — Henry accepts the invite and joins (criterion 3)

1. Henry checks his email, clicks the invite link.
2. Henry opens the **Team** space in Lazy.
3. **Expected**: Henry sees the Acme org (MemberView, role: member).
4. `activateTeamBrainOnLogin` runs on Henry's machine:
   - Reads `brainRepoUrl` from the org context (NOT a convention URL).
   - Clones `acme/lazy-brain` into the local team brain dir.
   - Applies `set_brain_config("custom", localDir)`.
   - Writes Henry's `active.json`.
5. **Verify**: Henry's Brain space now shows Alice's file-neurons.

### Step 4 — Henry's captures merge without conflict (criterion 4)

1. Henry connects his GitHub account (Settings → GitHub).
2. Henry captures a bug from a conversation.
3. The sync daemon pushes Henry's capture to the team repo.
4. **Expected**: `neurons/*.html merge=union` in `.gitattributes` means
   Henry's new neuron is appended, not conflicting with Alice's.
5. **Verify**: Alice pulls (next sync cycle) and sees Henry's bug neuron
   with `data-cerveau-author="Henry"`.

### Step 5 — Two authors, same file (criterion 5)

1. Alice and Henry both have a decision about the same file
   (`src/payments/stripe.ts`).
2. After sync, the file-neuron's decisions section shows TWO `<li>` entries:
   - One with `data-cerveau-author-id="<alice-uuid>"`.
   - One with `data-cerveau-author-id="<henry-uuid>"`.
3. **Verify**: `recomposeFileNeuronEnrichment` preserves both, sorted by
   date descending.

### Step 6 — Dedup by itemId (criterion 6)

1. Henry re-captures a decision that Alice already captured (same itemId
   from the same conversation source).
2. **Expected**: `recomposeFileNeuronEnrichment` deduplicates — only one
   `<li>` appears, not two.
3. **Verify**: The decisions section has one entry, not a duplicate.

### Step 7 — Search finds Alice's neurons from Henry's machine (criterion 7)

1. Henry opens the Brain space and searches for "stripe".
2. **Expected**: `brain_query_css` returns Alice's file-neuron for
   `src/payments/stripe.ts` (it's in the shared clone).
3. **Verify**: The search result shows Alice as the author.

### Step 8 — Secrets are scrubbed (criterion 8)

1. Alice pastes an API key into a conversation (`sk-ant-...`).
2. The capture pipeline runs `scrubSecrets` before writing.
3. **Expected**: The stored neuron contains `[REDACTED]` instead of the key.
4. **Verify**: Henry's search for the key returns nothing.

### Step 9 — Logout invalidates the author cache (criterion 9)

1. Alice signs out.
2. `invalidateCaptureAuthor()` runs (via `clearTeamsToken`).
3. Alice signs back in as a different user.
4. **Expected**: The next capture is attributed to the new user, not Alice.
5. **Verify**: New neurons carry the new author's name/id.

### Step 10 — Deactivate switches back to project mode (criterion 10)

1. Alice clicks **Leave team** in the Team space.
2. `deactivateTeamBrain` runs:
   - Finds the latest archive (from Step 1).
   - Switches `set_brain_config("custom", archivePath)`.
   - Clears `active.json`.
   - Invalidates the author cache.
3. **Expected**: Alice's brain reverts to her archived solo brain.
4. **Verify**: The Brain space shows Alice's original solo neurons.

### Step 11 — No convention URL (criterion 11)

1. Inspect the org context fetched on login.
2. **Expected**: `brainRepoUrl` is the real GitHub URL
   (`https://github.com/acme/lazy-brain.git`), never a derived
   `https://github.com/<slug>/brain-trunk`.
3. **Verify**: `activateTeamBrainOnLogin` is called with the real URL, or
   not called at all when `brainRepoUrl` is null.

### Step 12 — Fresh install (Claire) sees the team brain after joining (criterion 12)

1. Claire accepts an invite to Acme.
2. Claire opens the Team space.
3. `activateTeamBrainOnLogin` clones the team brain into Claire's local dir.
4. **Expected**: Claire's Brain space shows the shared neurons (Alice +
   Henry's captures), even though Claire never scanned any code herself.
5. **Verify**: Search for "stripe" returns results from the team brain.
