/**
 * Settings store — key-value pairs in data/db/settings.csv.
 * Used for org-wide configuration (e.g. max_team_count, password_policy).
 */

import { SETTINGS_CSV } from '../config.js';
import type { Setting } from '../domain/types.js';
import { readTable, writeTable } from './csv.js';
import { SETTINGS_SCHEMA } from './schemas.js';

function rowToSetting(row: Record<string, string>): Setting {
  return {
    key: row.key!,
    value: row.value!,
    updatedAt: row.updatedAt!,
  };
}

function settingToRow(s: Setting): Record<string, string> {
  return { key: s.key, value: s.value, updatedAt: s.updatedAt };
}

export function listSettings(): Setting[] {
  return readTable(SETTINGS_CSV, SETTINGS_SCHEMA).map(rowToSetting);
}

export function getSetting(key: string): string | undefined {
  return listSettings().find((s) => s.key === key)?.value;
}

export function setSetting(key: string, value: string, updatedAt: string): Setting {
  const all = listSettings();
  const idx = all.findIndex((s) => s.key === key);
  const setting: Setting = { key, value, updatedAt };

  const newList =
    idx === -1 ? [...all, setting] : [...all.slice(0, idx), setting, ...all.slice(idx + 1)];

  writeTable(SETTINGS_CSV, SETTINGS_SCHEMA, newList.map(settingToRow));
  return setting;
}

export function deleteSetting(key: string): boolean {
  const all = listSettings();
  const filtered = all.filter((s) => s.key !== key);
  if (filtered.length === all.length) {
    return false;
  }
  writeTable(SETTINGS_CSV, SETTINGS_SCHEMA, filtered.map(settingToRow));
  return true;
}
