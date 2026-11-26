import React from 'react';
import { Menu, ChevronRight, PenSquare, HelpCircle } from 'lucide-react';
import { WorkspaceIndicator } from './WorkspaceIndicator.js';
import { DensityToggle } from '../ui/DensityToggle.js';

export interface HeaderProps {
  page: string;
  heading: string;
  inboxUnread: number;
  mobileNav: boolean;
  menuButtonRef: React.RefObject<HTMLButtonElement | null>;
  onOpenMobileNav: () => void;
  onOpenCompose: () => void;
  onOpenShortcuts: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  page,
  heading,
  inboxUnread,
  mobileNav,
  menuButtonRef,
  onOpenMobileNav,
  onOpenCompose,
  onOpenShortcuts
}) => {
  return (
    <header className="topbar">
      <button
        className="icon mobile"
        aria-label="Open menu"
        aria-controls="workspace-navigation"
        aria-expanded={mobileNav}
        ref={menuButtonRef as any}
        onClick={onOpenMobileNav}
      >
        <Menu size={20} />
        {inboxUnread > 0 && <span className="mobile-unread-dot" aria-hidden="true" />}
      </button>

      <span>Workspace</span>
      <ChevronRight size={13} aria-hidden="true" />
      <strong className="ellipsis">{page === 'Inbox' ? heading : page}</strong>
      <span className="sr-only" role="status">
        {inboxUnread > 0 ? `${inboxUnread} unread inbox messages` : 'No unread inbox messages'}
      </span>

      <div className="topbar-actions">
        <WorkspaceIndicator />
        <DensityToggle />
        <button
          type="button"
          className="button icon"
          onClick={onOpenShortcuts}
          title="Keyboard shortcuts (?)"
          aria-label="Open keyboard shortcuts cheat-sheet"
        >
          <HelpCircle size={16} />
        </button>
        <button
          type="button"
          className="button primary"
          onClick={onOpenCompose}
          title="Compose Outbound Email (Press c)"
          aria-label="Compose new outbound email"
        >
          <PenSquare size={15} />
          <span className="compose-label">Compose</span>
        </button>
      </div>
    </header>
  );
};
