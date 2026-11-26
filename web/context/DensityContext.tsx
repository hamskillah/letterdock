import React, { createContext, useContext, useEffect, useState } from 'react';

export type Density = 'comfortable' | 'compact';

interface DensityContextType {
  density: Density;
  toggleDensity: () => void;
  setDensity: (d: Density) => void;
}

const DensityContext = createContext<DensityContextType>({
  density: 'comfortable',
  toggleDensity: () => {},
  setDensity: () => {}
});

export function DensityProvider({ children }: { children: React.ReactNode }) {
  const [density, setDensityState] = useState<Density>(() => {
    try {
      const saved = localStorage.getItem('letterdock_density');
      return saved === 'compact' ? 'compact' : 'comfortable';
    } catch {
      return 'comfortable';
    }
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-density', density);
    try {
      localStorage.setItem('letterdock_density', density);
    } catch {
      // storage disabled
    }
  }, [density]);

  const toggleDensity = () => {
    setDensityState(current => (current === 'comfortable' ? 'compact' : 'comfortable'));
  };

  const setDensity = (d: Density) => {
    setDensityState(d);
  };

  return (
    <DensityContext.Provider value={{ density, toggleDensity, setDensity }}>
      {children}
    </DensityContext.Provider>
  );
}

export function useDensity() {
  return useContext(DensityContext);
}
