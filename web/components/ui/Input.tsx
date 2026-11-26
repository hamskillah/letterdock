import React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export const Input: React.FC<InputProps> = ({
  label,
  error,
  hint,
  id,
  className = '',
  ...props
}) => {
  const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

  return (
    <div className="input-group">
      {label && <label htmlFor={inputId}>{label}</label>}
      <input
        id={inputId}
        className={`input ${error ? 'error' : ''} ${className}`.trim()}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
        {...props}
      />
      {hint && !error && (
        <span id={`${inputId}-hint`} className="input-hint">
          {hint}
        </span>
      )}
      {error && (
        <span id={`${inputId}-error`} className="input-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
};
