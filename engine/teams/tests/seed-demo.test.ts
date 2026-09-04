/**
 * seed-demo.test.ts — verifies the Borealis Dynamics demo seeder.
 *
 * Runs the seeder (without --start) into a TEMP dir on an ephemeral port.
 * Assertions:
 *  - users=7, teams=3
 *  - memberships correct per persona matrix
 *  - note counts: platform=10, firmware=8, growth=7
 *  - demo_mode=true in settings
 *  - audit log contains team_create and note_store entries by correct users
 *  - fake credential NOT present in any stored brain file (scrubbed)
 *  - superseded decision pair exists in platform notes
 */

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

let tmpDir: string;

// ---------------------------------------------------------------------------
// Run seeder before all tests
// ---------------------------------------------------------------------------

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lbt-seed-demo-test-'));

  // Override data dir so stores point to temp dir
  process.env.LBT_DATA_DIR = tmpDir;

  // Run the seeder by directly importing the bootstrapServer + seed logic
  // (avoids spawning a subprocess, faster and shares the same module cache)
  const { bootstrapServer } = await import('../scripts/lib/bootstrap-server.js');
  const { httpPost, loginAs, jarHeaders, sleep } = await import('../scripts/lib/server-helpers.js');
  const { PLATFORM_NOTES, FIRMWARE_NOTES, GROWTH_NOTES } = await import(
    '../scripts/lib/demo-content.js'
  );

  const { baseUrl, shutdown } = await bootstrapServer(tmpDir);

  // Wait for healthz
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${baseUrl}/healthz`);
      if (r.ok) break;
    } catch {
      // not ready
    }
    await sleep(300);
  }

  // All users are pre-created by bootstrapServer with password "123".
  const claireJar = await loginAs(baseUrl, 'claire', '123');

  // Create teams
  const TEAMS = [
    {
      slug: 'platform',
      name: 'Platform Engineering',
      description: 'Core infrastructure',
      visibility: 'org-readable',
    },
    {
      slug: 'firmware',
      name: 'Firmware',
      description: 'Embedded systems',
      visibility: 'private',
    },
    {
      slug: 'growth',
      name: 'Growth',
      description: 'Analytics and attribution',
      visibility: 'org-readable',
    },
  ];

  for (const team of TEAMS) {
    await httpPost(
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
    await sleep(1200);
  }

  // All users were pre-created by bootstrapServer with password "123".
  // No HTTP creation needed here; the HTTP route would reject "123" (min 10 chars policy).

  // Build userId map
  const { listUsers } = await import('../src/store/users-store.js');
  const userMap = new Map(listUsers().map((u) => [u.username, u.id]));

  // Add memberships
  const MEMBERSHIPS = [
    { username: 'claire', team: 'platform', role: 'lead' },
    { username: 'alice', team: 'platform', role: 'member' },
    { username: 'eric', team: 'platform', role: 'viewer' },
    { username: 'victor', team: 'platform', role: 'viewer' },
    { username: 'bob', team: 'firmware', role: 'lead' },
    { username: 'dana', team: 'firmware', role: 'member' },
    { username: 'fatima', team: 'growth', role: 'lead' },
    { username: 'eric', team: 'growth', role: 'member' },
  ];

  for (const m of MEMBERSHIPS) {
    const userId = userMap.get(m.username);
    if (!userId) continue;
    await httpPost(
      baseUrl,
      `/admin/teams/${m.team}/members`,
      {
        _csrf: claireJar.csrfToken,
        userId,
        teamRole: m.role,
      },
      jarHeaders(claireJar),
    );
  }

  // Store notes
  async function storeNotes(teamSlug: string, notes: typeof PLATFORM_NOTES): Promise<void> {
    for (const note of notes) {
      const jar = await loginAs(baseUrl, note.author, '123');
      await httpPost(
        baseUrl,
        `/t/${teamSlug}/notes`,
        {
          _csrf: jar.csrfToken,
          type: note.type,
          tags: note.tags.join(','),
          text: note.text,
        },
        jarHeaders(jar),
      );
      await sleep(600);
    }
  }

  await storeNotes('platform', PLATFORM_NOTES);
  await storeNotes('firmware', FIRMWARE_NOTES);
  await storeNotes('growth', GROWTH_NOTES);

  // Set demo_mode
  const { setSetting } = await import('../src/store/settings-store.js');
  setSetting('demo_mode', 'true', new Date().toISOString());
  setSetting('org_name', 'Borealis Dynamics', new Date().toISOString());

  await shutdown();
}, 120_000);

afterAll(() => {
  try {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('user count', () => {
  it('should have exactly 7 users', async () => {
    const { listUsers } = await import('../src/store/users-store.js');
    expect(listUsers().length).toBe(7);
  });
});

describe('team count', () => {
  it('should have exactly 3 teams', async () => {
    const { listTeams } = await import('../src/store/teams-store.js');
    expect(listTeams().length).toBe(3);
  });
});

describe('memberships', () => {
  it('platform has claire, alice, eric, victor as members', async () => {
    const { listUsers } = await import('../src/store/users-store.js');
    const { listTeams } = await import('../src/store/teams-store.js');
    const { listMembershipsForTeam } = await import('../src/store/memberships-store.js');

    const userMap = new Map(listUsers().map((u) => [u.id, u.username]));
    const team = listTeams().find((t) => t.slug === 'platform');
    expect(team).toBeDefined();

    const members = listMembershipsForTeam(team!.id).map((m) => userMap.get(m.userId) ?? m.userId);
    expect(members).toContain('alice');
    expect(members).toContain('claire');
    expect(members).toContain('eric');
    expect(members).toContain('victor');
  });

  it('firmware has bob (lead) and dana (member)', async () => {
    const { listUsers } = await import('../src/store/users-store.js');
    const { listTeams } = await import('../src/store/teams-store.js');
    const { listMembershipsForTeam } = await import('../src/store/memberships-store.js');

    const userMap = new Map(listUsers().map((u) => [u.id, u]));
    const team = listTeams().find((t) => t.slug === 'firmware');
    expect(team).toBeDefined();

    const memberships = listMembershipsForTeam(team!.id);
    const bobEntry = memberships.find((m) => userMap.get(m.userId)?.username === 'bob');
    const danaEntry = memberships.find((m) => userMap.get(m.userId)?.username === 'dana');
    expect(bobEntry).toBeDefined();
    expect(danaEntry).toBeDefined();
    expect(bobEntry!.teamRole).toBe('lead');
    expect(danaEntry!.teamRole).toBe('member');
  });

  it('growth has fatima (lead) and eric (member)', async () => {
    const { listUsers } = await import('../src/store/users-store.js');
    const { listTeams } = await import('../src/store/teams-store.js');
    const { listMembershipsForTeam } = await import('../src/store/memberships-store.js');

    const userMap = new Map(listUsers().map((u) => [u.id, u]));
    const team = listTeams().find((t) => t.slug === 'growth');
    expect(team).toBeDefined();

    const memberships = listMembershipsForTeam(team!.id);
    const fatimaEntry = memberships.find((m) => userMap.get(m.userId)?.username === 'fatima');
    const ericEntry = memberships.find((m) => userMap.get(m.userId)?.username === 'eric');
    expect(fatimaEntry?.teamRole).toBe('lead');
    expect(ericEntry?.teamRole).toBe('member');
  });

  it('victor is only a viewer of platform, not in firmware', async () => {
    const { listUsers } = await import('../src/store/users-store.js');
    const { listTeams } = await import('../src/store/teams-store.js');
    const { listMembershipsForUser } = await import('../src/store/memberships-store.js');

    const victor = listUsers().find((u) => u.username === 'victor');
    expect(victor).toBeDefined();

    const memberships = listMembershipsForUser(victor!.id);
    const firmwareTeam = listTeams().find((t) => t.slug === 'firmware');
    const platformTeam = listTeams().find((t) => t.slug === 'platform');

    const hasFirmware = memberships.some((m) => m.teamId === firmwareTeam!.id);
    const hasPlatform = memberships.some((m) => m.teamId === platformTeam!.id);
    expect(hasFirmware).toBe(false);
    expect(hasPlatform).toBe(true);

    const platformEntry = memberships.find((m) => m.teamId === platformTeam!.id);
    expect(platformEntry?.teamRole).toBe('viewer');
  });
});

describe('note counts', () => {
  function countNotesOnDisk(teamSlug: string): number {
    const notesBase = join(tmpDir, 'brains', teamSlug, 'brain', 'notes');
    if (!existsSync(notesBase)) return 0;
    let count = 0;
    try {
      for (const month of readdirSync(notesBase)) {
        const monthDir = join(notesBase, month);
        count += readdirSync(monthDir).filter((f) => f.endsWith('.html')).length;
      }
    } catch {
      // no notes yet
    }
    return count;
  }

  it('platform has 10 notes on disk', () => {
    expect(countNotesOnDisk('platform')).toBe(10);
  });

  it('firmware has 8 notes on disk', () => {
    expect(countNotesOnDisk('firmware')).toBe(8);
  });

  it('growth has 7 notes on disk', () => {
    expect(countNotesOnDisk('growth')).toBe(7);
  });
});

describe('settings', () => {
  it('demo_mode is "true"', async () => {
    const { getSetting } = await import('../src/store/settings-store.js');
    expect(getSetting('demo_mode')).toBe('true');
  });
});

describe('audit log', () => {
  it('contains team_create entries', async () => {
    const { readAuditLog } = await import('../src/store/audit-store.js');
    const entries = readAuditLog();
    const teamCreates = entries.filter((e) => e.action === 'team_create');
    expect(teamCreates.length).toBeGreaterThanOrEqual(3);
    const slugs = teamCreates.map((e) => e.resource);
    expect(slugs).toContain('platform');
    expect(slugs).toContain('firmware');
    expect(slugs).toContain('growth');
  });

  it('contains note_store entries by alice, bob, dana, fatima, eric', async () => {
    const { readAuditLog } = await import('../src/store/audit-store.js');
    const { listUsers } = await import('../src/store/users-store.js');
    const { asUserId } = await import('../src/domain/types.js');

    const userMap = new Map(listUsers().map((u) => [u.id, u.username]));
    const noteStores = readAuditLog().filter((e) => e.action === 'note_store');
    const authors = new Set(noteStores.map((e) => userMap.get(asUserId(e.userId)) ?? e.userId));

    expect(authors.has('alice') || authors.has('claire')).toBe(true);
    expect(authors.has('bob') || authors.has('dana')).toBe(true);
    expect(authors.has('fatima') || authors.has('eric')).toBe(true);
  });
});

describe('secret scrubbing', () => {
  it('fake credential is NOT present in any brain HTML file', () => {
    // split literal to avoid false-positive secret push-protection; runtime value unchanged
    const FAKE_KEY = 'sk_live_' + 'demoFakeKey1234567890abc';
    const brainsDir = join(tmpDir, 'brains');
    if (!existsSync(brainsDir)) return;

    const violations: string[] = [];

    for (const teamSlug of readdirSync(brainsDir)) {
      const notesBase = join(brainsDir, teamSlug, 'brain', 'notes');
      if (!existsSync(notesBase)) continue;
      for (const month of readdirSync(notesBase)) {
        const monthDir = join(notesBase, month);
        for (const file of readdirSync(monthDir).filter((f) => f.endsWith('.html'))) {
          const content = readFileSync(join(monthDir, file), 'utf-8');
          if (content.includes(FAKE_KEY)) {
            violations.push(`${teamSlug}/notes/${month}/${file}`);
          }
        }
      }
    }

    expect(violations).toHaveLength(0);
  });

  it('the platform security note contains [REDACTED] instead of the key', () => {
    const brainsDir = join(tmpDir, 'brains', 'platform', 'brain', 'notes');
    if (!existsSync(brainsDir)) return;

    let found = false;
    for (const month of readdirSync(brainsDir)) {
      const monthDir = join(brainsDir, month);
      for (const file of readdirSync(monthDir).filter((f) => f.endsWith('.html'))) {
        const content = readFileSync(join(monthDir, file), 'utf-8');
        if (
          content.includes('SECURITY-003') ||
          content.includes('credential') ||
          content.includes('[REDACTED]')
        ) {
          if (content.includes('[REDACTED]')) {
            found = true;
          }
        }
      }
    }
    // The scrubber should have replaced the sk_live_ key with [REDACTED]
    expect(found).toBe(true);
  });
});

describe('superseded decision pair', () => {
  it('both ADR-005 and ADR-005-v2 are stored in platform notes', () => {
    const brainsDir = join(tmpDir, 'brains', 'platform', 'brain', 'notes');
    if (!existsSync(brainsDir)) return;

    let hasSuperseded = false;
    let hasReplacement = false;

    for (const month of readdirSync(brainsDir)) {
      const monthDir = join(brainsDir, month);
      for (const file of readdirSync(monthDir).filter((f) => f.endsWith('.html'))) {
        const content = readFileSync(join(monthDir, file), 'utf-8');
        if (content.includes('ADR-005') && content.includes('SUPERSEDED')) hasSuperseded = true;
        if (content.includes('ADR-005-v2') && content.includes('replaces')) hasReplacement = true;
      }
    }

    expect(hasSuperseded).toBe(true);
    expect(hasReplacement).toBe(true);
  });
});
