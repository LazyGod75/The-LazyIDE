/* QA fix (B5) — Settings sub-tab deep-linking.
   AccountPopover's "Créer une équipe" and the palette's "Aller à :
   Réglages" both need to land on the Compte tab instead of always falling
   back to General. The mechanism: setActiveSpace(space, tab?) and the
   nav:navigateSpace bus event (string OR { space, tab } payload) both
   funnel through AppContext's single navigateToSpace path, which exposes
   the resolved tab as `settingsInitialTab` for AppShell's SpaceContent to
   read. This file locks that contract at the AppContext level (AppShell's
   own SpaceContent wiring is exercised end-to-end by the manual /
   screenshot verification pass, not unit-tested here — SpaceContent isn't
   exported and pulls in every lazy space module).
*/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AppProvider, useAppContext } from '../app/AppContext';
import { emit } from '../lib/bus';

function wrapper({ children }: { children: React.ReactNode }) {
  return <AppProvider>{children}</AppProvider>;
}

describe('AppContext — nav:navigateSpace / setActiveSpace tab deep-link', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('setActiveSpace(space) with no tab leaves settingsInitialTab null', () => {
    const { result } = renderHook(() => useAppContext(), { wrapper });

    act(() => result.current.setActiveSpace('settings'));

    expect(result.current.activeSpace).toBe('settings');
    expect(result.current.settingsInitialTab).toBeNull();
  });

  it('setActiveSpace(space, tab) resolves both activeSpace and settingsInitialTab', () => {
    const { result } = renderHook(() => useAppContext(), { wrapper });

    act(() => result.current.setActiveSpace('settings', 'account'));

    expect(result.current.activeSpace).toBe('settings');
    expect(result.current.settingsInitialTab).toBe('account');
  });

  it('a later navigation without a tab clears a previously-set one', () => {
    const { result } = renderHook(() => useAppContext(), { wrapper });

    act(() => result.current.setActiveSpace('settings', 'account'));
    expect(result.current.settingsInitialTab).toBe('account');

    act(() => result.current.setActiveSpace('code'));
    expect(result.current.settingsInitialTab).toBeNull();
  });

  it('nav:navigateSpace bus event — plain string form switches the space with no tab', () => {
    const { result } = renderHook(() => useAppContext(), { wrapper });

    act(() => emit('nav:navigateSpace', 'account'));

    expect(result.current.activeSpace).toBe('account');
    expect(result.current.settingsInitialTab).toBeNull();
  });

  it('nav:navigateSpace bus event — object form deep-links to the requested tab (AccountPopover "Créer une équipe" / palette "Aller à : Réglages")', () => {
    const { result } = renderHook(() => useAppContext(), { wrapper });

    act(() => emit('nav:navigateSpace', { space: 'settings', tab: 'account' }));

    expect(result.current.activeSpace).toBe('settings');
    expect(result.current.settingsInitialTab).toBe('account');
  });

  it('nav:navigateSpace { account, signin } carries the AuthScreen Sign in deep-link', () => {
    const { result } = renderHook(() => useAppContext(), { wrapper });

    act(() => emit('nav:navigateSpace', { space: 'account', tab: 'signin' }));

    expect(result.current.activeSpace).toBe('account');
    expect(result.current.settingsInitialTab).toBe('signin');
  });
});
