/**
 * seed-demo.ts — seeds the Borealis Dynamics demo into a LazyBrain Teams instance.
 *
 * Usage:
 *   tsx scripts/seed-demo.ts [--fresh] [--start]
 *
 * --fresh  Delete the existing data dir before seeding (required if dir is non-empty).
 * --start  Keep the server running after seeding and print the access guide.
 *
 * Without --fresh, refuses to touch a non-empty data dir.
 */

import { existsSync, readdirSync, rmSync } from 'node:fs';

import { bootstrapServer } from './lib/bootstrap-server.js';
import { FIRMWARE_NOTES, GROWTH_NOTES, PLATFORM_NOTES } from './lib/demo-content.js';
import { httpPost, jarHeaders, loginAs, sleep } from './lib/server-helpers.js';

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const FRESH = args.includes('--fresh');
const START = args.includes('--start');

const DATA_DIR = process.env.LBT_DATA_DIR ?? './data';

// ---------------------------------------------------------------------------
// Data dir guard
// ---------------------------------------------------------------------------

function prepareDataDir(): void {
  if (!existsSync(DATA_DIR)) return;

  const entries = readdirSync(DATA_DIR);
  if (entries.length === 0) return;

  if (!FRESH) {
    process.stderr.write(
      `[seed] ERROR: Data dir "${DATA_DIR}" is non-empty. Pass --fresh to delete it first.\n`,
    );
    process.exit(1);
  }

  process.stderr.write(`[seed] --fresh: removing "${DATA_DIR}"\n`);
  rmSync(DATA_DIR, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Persona definitions
// ---------------------------------------------------------------------------

interface Persona {
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
  readonly orgRole: 'admin' | 'member';
  readonly password: string;
  readonly demo: string;
}

const PERSONAS: Persona[] = [
  {
    username: 'claire',
    displayName: 'Claire Moreau',
    email: 'claire@borealis-dynamics.dev',
    orgRole: 'admin',
    password: '123',
    demo: 'Org admin — manage users, teams, audit log',
  },
  {
    username: 'alice',
    displayName: 'Alice Tan',
    email: 'alice@borealis-dynamics.dev',
    orgRole: 'member',
    password: '123',
    demo: 'Platform member — note authorship, wiki, search',
  },
  {
    username: 'bob',
    displayName: 'Bob Petrov',
    email: 'bob@borealis-dynamics.dev',
    orgRole: 'member',
    password: '123',
    demo: 'Firmware lead — private team, RTOS decisions',
  },
  {
    username: 'dana',
    displayName: 'Dana Okafor',
    email: 'dana@borealis-dynamics.dev',
    orgRole: 'member',
    password: '123',
    demo: 'Firmware member — hardware bugs, vendor errata',
  },
  {
    username: 'eric',
    displayName: 'Eric Lindqvist',
    email: 'eric@borealis-dynamics.dev',
    orgRole: 'member',
    password: '123',
    demo: 'Growth member + platform viewer — cross-team search',
  },
  {
    username: 'fatima',
    displayName: 'Fatima Benali',
    email: 'fatima@borealis-dynamics.dev',
    orgRole: 'member',
    password: '123',
    demo: 'Growth lead — attribution decisions, brand voice',
  },
  {
    username: 'victor',
    displayName: 'Victor Haas',
    email: 'victor@borealis-dynamics.dev',
    orgRole: 'member',
    password: '123',
    demo: 'Platform viewer (read-only) — stakeholder persona',
  },
];

// ---------------------------------------------------------------------------
// Team definitions
// ---------------------------------------------------------------------------

interface TeamDef {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly visibility: 'org-readable' | 'private';
}

const TEAMS: TeamDef[] = [
  {
    slug: 'platform',
    name: 'Platform Engineering',
    description: 'Core infrastructure, billing, observability and developer tooling',
    visibility: 'org-readable',
  },
  {
    slug: 'firmware',
    name: 'Firmware',
    description: 'Embedded systems, RTOS, CAN bus and hardware bring-up for Hydra-7',
    visibility: 'private',
  },
  {
    slug: 'growth',
    name: 'Growth',
    description: 'Analytics, attribution, SEO and partner integrations',
    visibility: 'org-readable',
  },
];

// ---------------------------------------------------------------------------
// Membership matrix
// ---------------------------------------------------------------------------

interface MembershipDef {
  readonly username: string;
  readonly team: string;
  readonly role: 'lead' | 'member' | 'viewer';
}

const MEMBERSHIPS: MembershipDef[] = [
  { username: 'claire', team: 'platform', role: 'lead' },
  { username: 'alice', team: 'platform', role: 'member' },
  { username: 'eric', team: 'platform', role: 'viewer' },
  { username: 'victor', team: 'platform', role: 'viewer' },
  { username: 'bob', team: 'firmware', role: 'lead' },
  { username: 'dana', team: 'firmware', role: 'member' },
  { username: 'fatima', team: 'growth', role: 'lead' },
  { username: 'eric', team: 'growth', role: 'member' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertRedirect(
  status: number,
  location: string | undefined,
  op: string,
  contains?: string,
): void {
  if (status !== 302) {
    throw new Error(`${op}: expected 302, got ${status} (location: ${location ?? 'none'})`);
  }
  if (contains && !location?.includes(contains)) {
    throw new Error(`${op}: expected location to contain "${contains}", got "${location ?? ''}"`);
  }
}

// ---------------------------------------------------------------------------
// Main seeder
// ---------------------------------------------------------------------------

async function seed(): Promise<void> {
  prepareDataDir();

  process.stderr.write(`[seed] Starting server against "${DATA_DIR}"...\n`);
  const { baseUrl, shutdown } = await bootstrapServer(DATA_DIR);
  process.stderr.write(`[seed] Server ready at ${baseUrl}\n`);

  // Wait for health
  let healthy = false;
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`${baseUrl}/healthz`);
      if (r.ok) {
        healthy = true;
        break;
      }
    } catch {
      // not ready yet
    }
    await sleep(300);
  }
  if (!healthy) throw new Error('Server did not become healthy within 6 seconds');

  // ---- 1. Login as claire (admin) ----------------------------------------
  // All users (including claire) are pre-created by bootstrapServer directly via
  // stores with password "123", bypassing the HTTP password policy.
  process.stderr.write('[seed] Logging in as claire...\n');
  const claireJar = await loginAs(baseUrl, 'claire', '123');

  // ---- 2. Create teams -----------------------------------------------------
  process.stderr.write('[seed] Creating teams...\n');
  for (const team of TEAMS) {
    const res = await httpPost(
      baseUrl,
      '/admin/teams',
      {
        _csrf: claireJar.csrfToken,
        slug: team.slug,
        name: team.name,
        description: team.description,
        visibility: team.visibility,
        retentionDays: '730',
      },
      jarHeaders(claireJar),
    );
    assertRedirect(res.status, res.headers.location, `create team ${team.slug}`, 'Team+created');
    process.stderr.write(`[seed]   team "${team.slug}" created\n`);
    // Give engine time to init brain
    await sleep(1500);
  }

  // ---- 3. (Users already created) Build userId map from store ------------
  // Users were pre-created by bootstrapServer directly via stores (password "123").
  // No HTTP call needed here; creating via HTTP would be blocked by the min-10-char
  // password policy.
  const { listUsers } = await import('../src/store/users-store.js');
  const { listTeams } = await import('../src/store/teams-store.js');

  const userMap = new Map(listUsers().map((u) => [u.username, u.id]));

  // ---- 5. Add memberships ------------------------------------------------
  process.stderr.write('[seed] Adding memberships...\n');
  for (const m of MEMBERSHIPS) {
    const userId = userMap.get(m.username);
    if (!userId) throw new Error(`User "${m.username}" not found`);

    const res = await httpPost(
      baseUrl,
      `/admin/teams/${m.team}/members`,
      {
        _csrf: claireJar.csrfToken,
        userId,
        teamRole: m.role,
      },
      jarHeaders(claireJar),
    );
    assertRedirect(
      res.status,
      res.headers.location,
      `add ${m.username} to ${m.team}`,
      'Member+added',
    );
    process.stderr.write(`[seed]   ${m.username} → ${m.team} (${m.role})\n`);
  }

  // ---- 6. Store notes as each author persona ----------------------------
  process.stderr.write('[seed] Storing platform notes...\n');
  for (const note of PLATFORM_NOTES) {
    const jar = await loginAs(baseUrl, note.author, '123');
    const res = await httpPost(
      baseUrl,
      '/t/platform/notes',
      {
        _csrf: jar.csrfToken,
        type: note.type,
        tags: note.tags.join(','),
        text: note.text,
      },
      jarHeaders(jar),
    );
    assertRedirect(
      res.status,
      res.headers.location,
      `platform note by ${note.author}`,
      'Note+stored',
    );
    process.stderr.write(`[seed]   platform: ${note.type} by ${note.author}\n`);
    await sleep(800);
  }

  process.stderr.write('[seed] Storing firmware notes...\n');
  for (const note of FIRMWARE_NOTES) {
    const jar = await loginAs(baseUrl, note.author, '123');
    const res = await httpPost(
      baseUrl,
      '/t/firmware/notes',
      {
        _csrf: jar.csrfToken,
        type: note.type,
        tags: note.tags.join(','),
        text: note.text,
      },
      jarHeaders(jar),
    );
    assertRedirect(
      res.status,
      res.headers.location,
      `firmware note by ${note.author}`,
      'Note+stored',
    );
    process.stderr.write(`[seed]   firmware: ${note.type} by ${note.author}\n`);
    await sleep(800);
  }

  process.stderr.write('[seed] Storing growth notes...\n');
  for (const note of GROWTH_NOTES) {
    const jar = await loginAs(baseUrl, note.author, '123');
    const res = await httpPost(
      baseUrl,
      '/t/growth/notes',
      {
        _csrf: jar.csrfToken,
        type: note.type,
        tags: note.tags.join(','),
        text: note.text,
      },
      jarHeaders(jar),
    );
    assertRedirect(
      res.status,
      res.headers.location,
      `growth note by ${note.author}`,
      'Note+stored',
    );
    process.stderr.write(`[seed]   growth: ${note.type} by ${note.author}\n`);
    await sleep(800);
  }

  // ---- 7. Set demo_mode=true in settings ---------------------------------
  process.stderr.write('[seed] Setting demo_mode...\n');
  const { setSetting } = await import('../src/store/settings-store.js');
  setSetting('demo_mode', 'true', new Date().toISOString());
  setSetting('org_name', 'Borealis Dynamics', new Date().toISOString());
  process.stderr.write('[seed] demo_mode=true and org_name=Borealis Dynamics set\n');

  // ---- 8. Summary --------------------------------------------------------
  const userCount = listUsers().length;
  const teamCount = listTeams().length;

  process.stdout.write('\n');
  process.stdout.write('Borealis Dynamics demo seeded successfully.\n');
  process.stdout.write(`  Users: ${userCount}  Teams: ${teamCount}\n`);
  process.stdout.write('  Notes: platform=10, firmware=8, growth=7\n');
  process.stdout.write('\n');

  if (START) {
    printGuide(baseUrl);
    process.stdout.write(`\nServer is running at ${baseUrl}\nPress Ctrl+C to stop.\n\n`);
    process.on('SIGINT', async () => {
      process.stderr.write('\n[seed] Shutting down...\n');
      await shutdown();
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      await shutdown();
      process.exit(0);
    });
    // Keep alive
    await new Promise(() => {});
  } else {
    await shutdown();
  }
}

function printGuide(baseUrl: string): void {
  const col1 = 10;
  const col2 = 20;
  const col3 = 15;
  const col4 = 48;
  const sep = `${'-'.repeat(col1 + col2 + col3 + col4 + 9)}`;

  process.stdout.write('\n');
  process.stdout.write('Borealis Dynamics — LazyBrain Teams Demo\n');
  process.stdout.write(`${sep}\n`);
  process.stdout.write(`URL: ${baseUrl}\n`);
  process.stdout.write('Password for every persona: 123\n');
  process.stdout.write(`${sep}\n`);

  const header = `${'Username'.padEnd(col1)} ${'Display Name'.padEnd(col2)} ${'Org Role'.padEnd(col3)} ${'What this persona demos'}`;
  process.stdout.write(`${header}\n`);
  process.stdout.write(`${sep}\n`);

  for (const p of PERSONAS) {
    const line = `${p.username.padEnd(col1)} ${p.displayName.padEnd(col2)} ${p.orgRole.padEnd(col3)} ${p.demo}`;
    process.stdout.write(`${line}\n`);
  }

  process.stdout.write(`${sep}\n`);
  process.stdout.write('\n');
  process.stdout.write('5 things to try:\n');
  process.stdout.write(
    '  1. Log in as victor (password: 123) and confirm /t/firmware returns 403 (viewer of platform only, not firmware).\n',
  );
  process.stdout.write(
    `  2. Log in as eric (password: 123) and search for "attribution" — hits from the growth team appear; firmware notes do not (private team).\n`,
  );
  process.stdout.write(
    '  3. Log in as claire (org admin) and browse /admin/audit to see the full activity trail with team_create, user_create, member_add, and note_store entries.\n',
  );
  process.stdout.write(
    '  4. Open the platform wiki (/t/platform/wiki as alice) and find the superseded canary-deploy decision pair (ADR-005 replaced by ADR-005-v2).\n',
  );
  process.stdout.write(
    '  5. Log in as claire and read the security incident note on platform — the api_key is stored as [REDACTED] on disk (governance scrubber demo).\n',
  );
  process.stdout.write('\n');
}

seed().catch((err) => {
  process.stderr.write(`[seed] FATAL: ${String(err)}\n`);
  process.exit(1);
});
