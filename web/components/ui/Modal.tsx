import React, { useEffect, useRef, useId } from 'react';
import { X } from 'lucide-react';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  maxWidth?: string;
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  description,
  children,
  maxWidth = '540px'
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      if (!openerRef.current) {
        openerRef.current = (document.activeElement as HTMLElement) || null;
      }
      if (!dialog.open) {
        dialog.showModal();
      }
      // Focus first focusable element inside dialog if focus is not yet inside
      if (!dialog.contains(document.activeElement)) {
        const focusable = dialog.querySelector<HTMLElement>(
          'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusable) {
          requestAnimationFrame(() => focusable.focus());
        }
      }
    } else {
      if (dialog.open) {
        dialog.close();
      }
      if (openerRef.current && typeof openerRef.current.focus === 'function') {
        const toFocus = openerRef.current;
        openerRef.current = null;
        try {
          toFocus.focus();
        } catch {}
      }
    }
  }, [isOpen]);

  const handleCancel = (e: React.SyntheticEvent) => {
    e.preventDefault();
    onClose();
  };

  // Keyboard focus trap safeguard (Tab & Shift+Tab within dialog)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDialogElement>) => {
    if (e.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter(el => el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0);

    if (focusables.length === 0) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first || document.activeElement === dialog) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="modal-dialog"
      onCancel={handleCancel}
      onKeyDown={handleKeyDown}
      style={{ maxWidth }}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
    >
      {isOpen && (
        <>
          <div className="modal-header">
            <div>
              <h2 id={titleId}>{title}</h2>
              {description && <p id={descId} className="modal-description">{description}</p>}
            </div>
            <button
              type="button"
              className="icon"
              aria-label="Close modal"
              onClick={onClose}
            >
              <X size={18} />
            </button>
          </div>
          <div className="modal-body">{children}</div>
        </>
      )}
    </dialog>
  );
};
