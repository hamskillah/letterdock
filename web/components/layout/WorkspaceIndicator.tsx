import React from 'react';
import { Layers } from 'lucide-react';

export const WorkspaceIndicator: React.FC<{ workspaceName?: string }> = ({
  workspaceName = 'Default workspace'
}) => {
  return (
    <div className="workspace-badge" title="Active workspace scope">
      <Layers size={13} aria-hidden="true" />
      <span>{workspaceName}</span>
    </div>
  );
};
