import { useTranslation } from 'react-i18next';
import type { UnsavedChangesPrompt } from '../hooks/use-unsaved-changes-prompt.js';
import { ConfirmDialog } from './confirm-dialog.js';

export function UnsavedChangesDialog({ isBlocked, confirm, cancel }: UnsavedChangesPrompt) {
  const { t } = useTranslation();

  return (
    <ConfirmDialog
      isOpen={isBlocked}
      title={t('dialog.unsavedChanges.title')}
      message={t('dialog.unsavedChanges.message')}
      confirmLabel={t('dialog.unsavedChanges.confirm')}
      cancelLabel={t('dialog.unsavedChanges.cancel')}
      onConfirm={confirm}
      onCancel={cancel}
    />
  );
}
