import React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'icon' | 'quiet';
  size?: 'sm' | 'md' | 'lg';
  busy?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  className = '',
  variant = 'secondary',
  size = 'md',
  busy = false,
  disabled,
  ...props
}) => {
  const variantClass =
    variant === 'primary'
      ? 'primary'
      : variant === 'danger'
      ? 'danger'
      : variant === 'icon'
      ? 'icon'
      : '';

  return (
    <button
      className={`button ${variantClass} size-${size} ${className}`.trim()}
      disabled={disabled || busy}
      {...props}
    >
      {busy ? '…' : children}
    </button>
  );
};
