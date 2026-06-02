/**
 * useUnsavedChangesPrompt — shared hook for all edit/create forms that need to
 * guard against accidental navigation with unsaved data.
 *
 * Usage pattern (future edit/create forms should follow this):
 *
 *   const { isBlocked, confirm, cancel } = useUnsavedChangesPrompt(isDirty);
 *   // then render:
 *   <ConfirmDialog
 *     isOpen={isBlocked}
 *     title="Unsaved changes"
 *     message="You have unsaved changes. Leave this page?"
 *     confirmLabel="[LEAVE]"
 *     cancelLabel="[STAY]"
 *     onConfirm={confirm}
 *     onCancel={cancel}
 *   />
 *
 * The hook covers two navigation scenarios:
 *  1. SPA internal navigation — uses react-router-dom's `useBlocker` (requires
 *     a data router, i.e. `createBrowserRouter` / `createMemoryRouter`).
 *  2. Tab / window close — registers a `beforeunload` handler while dirty.
 *
 * NOTE: requires the app to use a data router (createBrowserRouter). Pages
 * rendered inside the legacy <BrowserRouter> will not benefit from the blocker.
 */

import { useEffect } from 'react';
import { useBlocker } from 'react-router-dom';

export type UnsavedChangesPrompt = {
  isBlocked: boolean;
  confirm: () => void;
  cancel: () => void;
};

export function useUnsavedChangesPrompt(isDirty: boolean): UnsavedChangesPrompt {
  // Block SPA-internal navigations when the form is dirty.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isDirty && currentLocation.pathname !== nextLocation.pathname,
  );

  // Double-guard: also prevent tab/window close while dirty.
  useEffect(() => {
    if (!isDirty) return;

    function handleBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = '';
    }

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  const isBlocked = blocker.state === 'blocked';

  function confirm() {
    if (blocker.state === 'blocked') {
      blocker.proceed();
    }
  }

  function cancel() {
    if (blocker.state === 'blocked') {
      blocker.reset();
    }
  }

  return { isBlocked, confirm, cancel };
}
