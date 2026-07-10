'use client';

import { ChevronDown, File, Folder, FolderOpen } from 'lucide-react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';

import type { FileInfo, FolderNode } from '@/app/prs/[id]/types';
import { buildFolderTree } from '@/app/prs/[id]/utils';

interface FileTreeProps {
  files: FileInfo[];
  expandedFiles: Set<string>;
  collapsedFolders: Set<string>;
  setCollapsedFolders: Dispatch<SetStateAction<Set<string>>>;
  toggleFile: (path: string) => void;
  scrollToDiff: (path: string) => void;
}

export default function FileTree({
  files,
  expandedFiles,
  collapsedFolders,
  setCollapsedFolders,
  toggleFile,
  scrollToDiff,
}: FileTreeProps) {
  const tree = buildFolderTree(files);
  const toggleFolder = (path: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const renderNode = (node: FolderNode, depth: number = 0): ReactNode[] => {
    const items: ReactNode[] = [];
    const indent = depth * 12;

    // Render child folders first
    const sortedFolders = Array.from(node.children.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    for (const [, childNode] of sortedFolders) {
      const isCollapsed = collapsedFolders.has(childNode.path);
      items.push(
        <button
          key={`folder-${childNode.path}`}
          className={`folder-item ${isCollapsed ? 'collapsed' : ''}`}
          onClick={() => toggleFolder(childNode.path)}
          style={{ paddingLeft: `${indent + 8}px` }}
        >
          <ChevronDown size={12} className="folder-icon" />
          {isCollapsed ? <Folder size={14} /> : <FolderOpen size={14} />}
          <span>{childNode.name}</span>
        </button>,
      );
      if (!isCollapsed) {
        items.push(...renderNode(childNode, depth + 1));
      }
    }

    // Render files
    const sortedFiles = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
    for (const file of sortedFiles) {
      items.push(
        <button
          key={file.path}
          className={`file-item ${expandedFiles.has(file.path) ? 'active' : ''}`}
          onClick={(e) => {
            e.preventDefault();
            if (!expandedFiles.has(file.path)) {
              toggleFile(file.path);
            }
            scrollToDiff(file.path);
          }}
          style={{ paddingLeft: `${indent + 8}px` }}
        >
          <File size={14} />
          <span className="file-name">{file.path.split('/').pop()}</span>
          <span className="file-stats">
            <span className="additions">+{file.additions}</span>
            <span className="deletions">-{file.deletions}</span>
          </span>
        </button>,
      );
    }

    return items;
  };

  return <>{renderNode(tree)}</>;
}
