import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * E103 — prove timeout / ops-status sources exist without requiring MSVC
 * to rebuild the Tauri binary. This is a source-level contract check.
 */
describe('brain ops timeout sources (E103)', () => {
  const root = join(__dirname, '..', '..');

  it('maintenance.rs declares dream step timeout', () => {
    const src = readFileSync(join(root, 'src-tauri/src/commands/brain/maintenance.rs'), 'utf8');
    expect(src).toMatch(/DREAM_STEP_TIMEOUT_SECS:\s*u64\s*=\s*600/);
    expect(src).toMatch(/wait_maintenance_child_with_timeout/);
  });

  it('index_project.rs declares auto-index step timeout', () => {
    const src = readFileSync(join(root, 'src-tauri/src/commands/brain/index_project.rs'), 'utf8');
    expect(src).toMatch(/AUTO_INDEX_STEP_TIMEOUT_SECS:\s*u64\s*=\s*180/);
    expect(src).toMatch(/run_step_with_timeout/);
  });

  it('ops.rs exposes brain_ops_status + ops-status.json', () => {
    const src = readFileSync(join(root, 'src-tauri/src/commands/brain/ops.rs'), 'utf8');
    expect(src).toMatch(/ops-status\.json/);
    expect(src).toMatch(/fn brain_ops_status/);
    expect(src).toMatch(/record_ops_timed_out/);
  });
});
