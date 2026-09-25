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
// The first of the tab bar's buttons to drop to icons as the viewport narrows -
// see .toolbar-compact-1 in globals.css.
export default function FileViewControls({
  onExpandAll,
  onCollapseAll,
  canExpand,
}: FileViewControlsProps) {
  return (
    <div className="file-view-controls">
      <button
        type="button"
        className={`file-view-btn toolbar-compact-1 ${canExpand ? 'can-expand' : ''}`}
        onClick={onExpandAll}
        title="Expand All"
        aria-label="Expand All"
      >
        <Maximize2 size={12} />
        <span className="toolbar-label">Expand All</span>
      </button>
      <button
        type="button"
        className="file-view-btn toolbar-compact-1"
        onClick={onCollapseAll}
        title="Collapse All"
        aria-label="Collapse All"
      >
        <Minimize2 size={12} />
        <span className="toolbar-label">Collapse All</span>
      </button>
    </div>
  );
}
