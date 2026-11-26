import React from 'react';

export const ShortcutHint: React.FC<{ shortcut: string; className?: string }> = ({
  shortcut,
  className = ''
}) => {
  return (
    <kbd className={`shortcut-hint ${className}`.trim()} aria-hidden="true">
      {shortcut}
    </kbd>
  );
};
