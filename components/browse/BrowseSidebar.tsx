'use client';

import type { TreeNode } from '@/app/browse/types';
import FileTree from '@/components/browse/FileTree';

interface BrowseSidebarProps {
  repoPath: string;
  tree: TreeNode | null;
  expandedFolders: Set<string>;
  selectedFile: string | null;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string) => void;
  onChangeRepo: () => void;
}

export default function BrowseSidebar({
  repoPath,
  tree,
  expandedFolders,
  selectedFile,
  onToggleFolder,
  onSelectFile,
  onChangeRepo,
}: BrowseSidebarProps) {
  return (
    <aside className="browse-sidebar">
      <div className="sidebar-section">
        <div className="sidebar-header">
          <h3>Files</h3>
          <button className="change-repo-btn" onClick={onChangeRepo}>
            Change
          </button>
        </div>
        <div className="repo-path-display">{repoPath.split('/').pop()}</div>
        <div className="file-list">
          {tree && (
            <FileTree
              node={tree}
              expandedFolders={expandedFolders}
              selectedFile={selectedFile}
              onToggleFolder={onToggleFolder}
              onSelectFile={onSelectFile}
            />
          )}
        </div>
      </div>
    </aside>
  );
}
