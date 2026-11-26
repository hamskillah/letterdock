import React from 'react';
import { Modal } from '../ui/Modal.js';
import { ShortcutHint } from '../ui/ShortcutHint.js';

export interface ShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const SHORTCUTS = [
  { key: 'j / k', desc: 'Navigate to next / previous email in the message list' },
  { key: 'Enter', desc: 'Open and inspect the focused email' },
  { key: 'e', desc: 'Archive selected email' },
  { key: '#', desc: 'Move selected email to Trash' },
  { key: 'c', desc: 'Open new Outbound Email Compose dialog' },
  { key: '/', desc: 'Instantly focus the search input' },
  { key: 'd', desc: 'Toggle density mode (Comfortable / Compact)' },
  { key: '?', desc: 'Open this keyboard shortcuts reference' },
  { key: 'Esc', desc: 'Close dialog, dismiss reader, or clear active selection' }
];

export const ShortcutsModal: React.FC<ShortcutsModalProps> = ({ isOpen, onClose }) => {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Keyboard Shortcuts"
      description="Letterdock is designed for rapid sovereign keyboard triage."
    >
      <div className="shortcuts-table">
        {SHORTCUTS.map(item => (
          <div key={item.key} className="shortcut-row">
            <ShortcutHint shortcut={item.key} />
            <span className="shortcut-desc">{item.desc}</span>
          </div>
        ))}
      </div>
      <div className="modal-footer">
        <button type="button" className="button primary" onClick={onClose}>
          Got it
        </button>
      </div>
    </Modal>
  );
};
