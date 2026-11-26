import React from 'react';
import { Star, Paperclip } from 'lucide-react';
import type { Message } from '../../types/index.js';
import { emailDate, senderName } from '../../api/client.js';

export interface MessageRowProps {
  message: Message;
  isSelected: boolean;
  isChosen: boolean;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onToggleStar: (id: string, starred: boolean) => void;
  onStartPress: (e: React.PointerEvent<HTMLButtonElement>, id: string) => void;
  onMovePress: (e: React.PointerEvent<HTMLButtonElement>) => void;
}

export const MessageRow: React.FC<MessageRowProps> = ({
  message,
  isSelected,
  isChosen,
  onSelect,
  onOpen,
  onToggleStar,
  onStartPress,
  onMovePress
}) => {
  const dateFormatted = emailDate.format(new Date(message.received));

  return (
    <button
      type="button"
      className={`message-row ${message.unread ? 'unread' : ''} ${
        isChosen ? 'chosen' : ''
      } ${isSelected ? 'selected' : ''}`}
      aria-label={`${message.unread ? 'Unread: ' : ''}${message.subject || 'No subject'} from ${senderName(
        message.sender
      )}`}
      onClick={e => {
        if (isSelected || (e.target as HTMLElement).closest('input[type="checkbox"], button.star-btn')) {
          return;
        }
        onOpen(message.id);
      }}
      onKeyDown={e => {
        if (e.key === ' ' || e.key === 'Enter') {
          if (e.shiftKey) {
            e.preventDefault();
            onSelect(message.id);
          } else {
            e.preventDefault();
            onOpen(message.id);
          }
        }
      }}
      onPointerDown={e => onStartPress(e, message.id)}
      onPointerMove={onMovePress}
    >
      <input
        type="checkbox"
        checked={isSelected}
        aria-label={`Select message: ${message.subject || 'No subject'}`}
        onClick={e => e.stopPropagation()}
        onChange={() => onSelect(message.id)}
      />

      <span className="unread-dot" aria-hidden="true" />

      <div className="row-main message-link">
        <div className="row-header">
          <div className="row-sender">
            <span className="ellipsis">{senderName(message.sender)}</span>
          </div>
          <div className="row-meta">
            <time dateTime={message.received}>{dateFormatted}</time>
          </div>
        </div>

        <div className="row-subject">
          <span className="ellipsis">{message.subject || '(No subject)'}</span>
        </div>

        {message.labels && message.labels.length > 0 && (
          <div className="row-tags">
            {message.labels.map(lbl => (
              <span key={lbl} className="tag-badge">
                {lbl}
              </span>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        className="icon star-btn"
        aria-label={message.starred ? 'Unstar message' : 'Star message'}
        onClick={e => {
          e.stopPropagation();
          onToggleStar(message.id, !message.starred);
        }}
      >
        <Star
          size={15}
          fill={message.starred ? 'currentColor' : 'none'}
          color={message.starred ? '#eab308' : 'currentColor'}
        />
      </button>
    </button>
  );
};
