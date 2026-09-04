/**
 * Users store — CRUD over data/db/users.csv.
 *
 * No in-memory cache: re-reads the CSV on every call.
 * Safe for the expected scale (< 10 000 users) and avoids stale-state bugs.
 */

import { USERS_CSV } from '../config.js';
import type { User, UserId } from '../domain/types.js';
import { asUserId } from '../domain/types.js';
import { readTable, writeTable } from './csv.js';
import { USERS_SCHEMA } from './schemas.js';

function rowToUser(row: Record<string, string>): User {
  return {
    id: asUserId(row.id!),
    username: row.username!,
    displayName: row.displayName!,
    email: row.email!,
    passwordHash: row.passwordHash!,
    orgRole: row.orgRole as User['orgRole'],
    status: row.status as User['status'],
    createdAt: row.createdAt!,
  };
}

function userToRow(user: User): Record<string, string> {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    passwordHash: user.passwordHash,
    orgRole: user.orgRole,
    status: user.status,
    createdAt: user.createdAt,
  };
}

export function listUsers(): User[] {
  return readTable(USERS_CSV, USERS_SCHEMA).map(rowToUser);
}

export function findUserById(id: UserId): User | undefined {
  return listUsers().find((u) => u.id === id);
}

export function findUserByUsername(username: string): User | undefined {
  return listUsers().find((u) => u.username === username);
}

export function findUserByEmail(email: string): User | undefined {
  return listUsers().find((u) => u.email === email);
}

export function createUser(user: User): User {
  const existing = listUsers();
  const updated = [...existing, user];
  writeTable(USERS_CSV, USERS_SCHEMA, updated.map(userToRow));
  return user;
}

export function updateUser(updated: User): User | undefined {
  const all = listUsers();
  const idx = all.findIndex((u) => u.id === updated.id);
  if (idx === -1) {
    return undefined;
  }
  const newList = [...all.slice(0, idx), updated, ...all.slice(idx + 1)];
  writeTable(USERS_CSV, USERS_SCHEMA, newList.map(userToRow));
  return updated;
}

export function deleteUser(id: UserId): boolean {
  const all = listUsers();
  const filtered = all.filter((u) => u.id !== id);
  if (filtered.length === all.length) {
    return false;
  }
  writeTable(USERS_CSV, USERS_SCHEMA, filtered.map(userToRow));
  return true;
}
