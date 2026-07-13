'use client';

import { GitCommit, Layers } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';

import FileTree from './FileTree';
import type { CommitInfo, FileInfo } from '@/app/prs/[id]/types';

interface PRSidebarProps {
  files: FileInfo[];
  expandedFiles: Set<string>;
  collapsedFolders: Set<string>;
  setCollapsedFolders: Dispatch<SetStateAction<Set<string>>>;
  toggleFile: (path: string) => void;
  scrollToDiff: (path: string) => void;
  commits: CommitInfo[];
  selectedCommit: string | null;
  selectCommit: (sha: string | null) => void;
}

export default function PRSidebar({
  files,
  expandedFiles,
  collapsedFolders,
  setCollapsedFolders,
  toggleFile,
  scrollToDiff,
  commits,
  selectedCommit,
  selectCommit,
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

      <div className="sidebar-section">
        <h3>Commits ({commits.length})</h3>
        <div className="file-list">
          <button
            className={`file-item commit-item ${selectedCommit === null ? 'active' : ''}`}
            onClick={() => selectCommit(null)}
          >
            <Layers size={14} />
            <span className="file-name">All commits</span>
          </button>
          {commits.map((commit) => (
            <button
              key={commit.sha}
              className={`file-item commit-item ${selectedCommit === commit.sha ? 'active' : ''}`}
              onClick={() => selectCommit(commit.sha)}
              title={`${commit.shortSha} by ${commit.author}`}
            >
              <GitCommit size={14} />
              <span className="file-name">{commit.message}</span>
              <span className="commit-sha">{commit.shortSha}</span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
