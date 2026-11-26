import React from 'react';

export const HeaderInspector: React.FC<{ headers: Record<string, unknown> }> = ({ headers }) => {
  if (!headers || Object.keys(headers).length === 0) return null;

  return (
    <details className="message-details">
      <summary>Technical RFC 822 Headers ({Object.keys(headers).length})</summary>
      <dl className="dns-data mono" style={{ maxHeight: '240px', overflowY: 'auto' }}>
        {Object.entries(headers).map(([key, value]) => (
          <React.Fragment key={key}>
            <dt>{key}</dt>
            <dd style={{ wordBreak: 'break-all' }}>
              {typeof value === 'object' ? JSON.stringify(value) : String(value)}
            </dd>
          </React.Fragment>
        ))}
      </dl>
    </details>
  );
};
