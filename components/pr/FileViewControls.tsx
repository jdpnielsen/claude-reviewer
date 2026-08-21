'use client';

import { Maximize2, Minimize2 } from 'lucide-react';

interface FileViewControlsProps {
  onExpandAll: () => void;
  onCollapseAll: () => void;
  // Whether any file is currently collapsed - i.e. "Expand All" would
  // actually change something. Drives the button's highlight so it doesn't
  // read as an available action when every file is already open.
  canExpand: boolean;
}

// Expand/Collapse all files in the diff view. Scoped to the Files Changed tab,
// so it lives in the tab bar next to the commit selector rather than the header.
export default function FileViewControls({
  onExpandAll,
  onCollapseAll,
  canExpand,
}: FileViewControlsProps) {
  return (
    <div style={{ display: 'flex', gap: '0.5rem' }}>
      <button
        onClick={onExpandAll}
        title="Expand All"
        style={{
          padding: '0.25rem 0.5rem',
          background: '#21262d',
          color: canExpand ? '#58a6ff' : '#8b949e',
          fontSize: '0.75rem',
          border: '1px solid #30363d',
          borderRadius: '4px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '0.25rem',
        }}
      >
        <Maximize2 size={12} />
        Expand All
      </button>
      <button
        onClick={onCollapseAll}
        title="Collapse All"
        style={{
          padding: '0.25rem 0.5rem',
          background: '#21262d',
          color: '#8b949e',
          fontSize: '0.75rem',
          border: '1px solid #30363d',
          borderRadius: '4px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '0.25rem',
        }}
      >
        <Minimize2 size={12} />
        Collapse All
      </button>
    </div>
  );
}
