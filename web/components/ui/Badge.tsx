import React from 'react';

export interface BadgeProps {
  children: React.ReactNode;
  variant?: 'ok' | 'warn' | 'error' | 'neutral' | 'accent';
  className?: string;
}

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = 'neutral',
  className = ''
}) => {
  return (
    <span className={`badge badge-${variant} ${className}`.trim()}>
      {children}
    </span>
  );
};
