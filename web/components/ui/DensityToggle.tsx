import React from 'react';
import { useDensity } from '../../context/DensityContext.js';
import { LayoutGrid, List } from 'lucide-react';

export const DensityToggle: React.FC = () => {
  const { density, toggleDensity } = useDensity();

  return (
    <button
      type="button"
      className="button icon density-toggle"
      onClick={toggleDensity}
      title={`Switch to ${density === 'comfortable' ? 'compact' : 'comfortable'} view (Press d)`}
      aria-label={`Current view is ${density}. Switch to ${density === 'comfortable' ? 'compact' : 'comfortable'}`}
    >
      {density === 'comfortable' ? <LayoutGrid size={16} /> : <List size={16} />}
      <span className="sr-only">Toggle density</span>
    </button>
  );
};
