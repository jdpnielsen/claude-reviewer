'use client';

import type { Dispatch, SetStateAction } from 'react';

import FileTree from './FileTree';
import type { FileInfo } from '@/app/prs/[id]/types';

interface PRSidebarProps {
  files: FileInfo[];
  expandedFiles: Set<string>;
  collapsedFolders: Set<string>;
  setCollapsedFolders: Dispatch<SetStateAction<Set<string>>>;
  toggleFile: (path: string) => void;
  scrollToDiff: (path: string) => void;
}

export default function PRSidebar({
  files,
  expandedFiles,
  collapsedFolders,
  setCollapsedFolders,
  toggleFile,
  scrollToDiff,
}: PRSidebarProps) {
  return (
    <aside className="pr-sidebar">
      <div className="sidebar-section">
        <h3>Files Changed ({files.length})</h3>
        <div className="file-list">
          <FileTree
            files={files}
            expandedFiles={expandedFiles}
            collapsedFolders={collapsedFolders}
            setCollapsedFolders={setCollapsedFolders}
            toggleFile={toggleFile}
            scrollToDiff={scrollToDiff}
          />
        </div>
      </div>
    </aside>
  );
}
