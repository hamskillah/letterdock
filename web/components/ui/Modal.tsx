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
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else {
      if (dialog.open) {
        dialog.close();
      }
    }
  }, [isOpen]);

  const handleCancel = (e: React.SyntheticEvent) => {
    e.preventDefault();
    onClose();
  };

  if (!isOpen) return null;

  return (
    <dialog
      ref={dialogRef}
      className="modal-dialog"
      onCancel={handleCancel}
      style={{ maxWidth }}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
    >
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
    </dialog>
  );
};
