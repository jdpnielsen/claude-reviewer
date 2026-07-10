'use client';

import { ChevronDown, File, Folder, FolderOpen, MessageSquare } from 'lucide-react';

import type { TreeNode } from '@/app/browse/types';

interface FileTreeProps {
  node: TreeNode;
  depth?: number;
  expandedFolders: Set<string>;
  selectedFile: string | null;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string) => void;
}

export default function FileTree({
  node,
  depth = 0,
  expandedFolders,
  selectedFile,
  onToggleFolder,
  onSelectFile,
}: FileTreeProps) {
  const isExpanded = expandedFolders.has(node.path);
  const indent = depth * 16;

  if (node.type === 'directory') {
    return (
      <div key={node.path}>
        <button
          className={`folder-item ${isExpanded ? '' : 'collapsed'}`}
          onClick={() => onToggleFolder(node.path)}
          style={{ paddingLeft: `${indent + 8}px` }}
        >
          <ChevronDown size={12} className="folder-icon" />
          {isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />}
          <span>{node.name}</span>
        </button>
        {isExpanded && node.children && (
          <div>
            {node.children.map((child) => (
              <FileTree
                key={child.path}
                node={child}
                depth={depth + 1}
                expandedFolders={expandedFolders}
                selectedFile={selectedFile}
                onToggleFolder={onToggleFolder}
                onSelectFile={onSelectFile}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      key={node.path}
      className={`file-item ${selectedFile === node.path ? 'active' : ''}`}
      onClick={() => onSelectFile(node.path)}
      style={{ paddingLeft: `${indent + 8}px` }}
    >
      <File size={14} />
      <span className="file-name">{node.name}</span>
      {node.conversationCount && node.conversationCount > 0 && (
        <span className="conversation-badge">
          <MessageSquare size={10} />
          {node.conversationCount}
        </span>
      )}
    </button>
  );
}
