/**
 * ConfirmModal — one shared "Are you sure?" popup for every delete
 * in the app, in the same style as the guest sign-out warning.
 * The caller passes the exact detail lines (what else goes away,
 * how many points come off), so no delete ever runs without the
 * user seeing what it takes with it.
 */

import { useModalFocus } from '@/lib/use-modal-focus';

type ConfirmModalProps = {
  title: string;
  lines: string[];
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ConfirmModal({
  title,
  lines,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  // The dialog mounts when it opens: move focus in, trap Tab,
  // close on Escape, return focus to the trigger on close.
  const dialogRef = useModalFocus<HTMLDivElement>(true, onCancel);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="bg-white rounded-2xl shadow-xl p-5 w-full max-w-sm space-y-4"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
      >
        <p className="text-base font-semibold text-gray-900">{title}</p>
        <div className="space-y-2">
          {lines.map((line) => (
            <p key={line} className="text-sm text-gray-700">
              {line}
            </p>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            onClick={onConfirm}
            disabled={busy}
            className="flex-1 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold py-2 px-3 rounded-xl transition-colors disabled:opacity-50"
          >
            {busy ? 'Deleting…' : confirmLabel}
          </button>
          <button
            onClick={onCancel}
            className="flex-1 bg-white border-2 border-gray-200 hover:border-gray-300 text-gray-700 text-sm font-medium py-2 px-3 rounded-xl transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
