'use client';

import { File } from 'lucide-react';

import ConversationItem from '@/components/browse/ConversationItem';
import type { Conversation, ConversationMessage } from '@/app/browse/conversations/types';

interface ConversationGroupsProps {
  groupedConversations: Record<string, Conversation[]>;
  repoPath: string;
  expandedConversation: string | null;
  conversationMessages: Record<string, ConversationMessage[]>;
  replyContent: string;
  claudeResponding: string | null;
  claudeError: string | null;
  onToggleConversation: (uuid: string) => void;
  onReplyChange: (value: string) => void;
  onAddReply: (conversationUuid: string) => void;
  onRespondWithClaude: (conversationUuid: string, autoCommit: boolean) => void;
  onResolveConversation: (uuid: string) => void;
  onDeleteConversation: (uuid: string) => void;
}

export default function ConversationGroups({
  groupedConversations,
  repoPath,
  expandedConversation,
  conversationMessages,
  replyContent,
  claudeResponding,
  claudeError,
  onToggleConversation,
  onReplyChange,
  onAddReply,
  onRespondWithClaude,
  onResolveConversation,
  onDeleteConversation,
}: ConversationGroupsProps) {
  return (
    <div className="conversations-grouped">
      {Object.entries(groupedConversations).map(([filePath, convs]) => (
        <div key={filePath} className="file-group">
          <div className="file-group-header">
            <File size={14} />
            <span className="file-path">{filePath}</span>
            <span className="conv-count">
              {convs.length} conversation{convs.length !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="file-conversations">
            {convs.map((conv, idx) => (
              <ConversationItem
                key={`${conv.uuid}-${idx}`}
                conv={conv}
                repoPath={repoPath}
                isExpanded={expandedConversation === conv.uuid}
                messages={conversationMessages[conv.uuid]}
                replyContent={replyContent}
                claudeResponding={claudeResponding}
                claudeError={claudeError}
                onToggle={() => onToggleConversation(conv.uuid)}
                onReplyChange={onReplyChange}
                onAddReply={onAddReply}
                onRespondWithClaude={onRespondWithClaude}
                onResolveConversation={onResolveConversation}
                onDeleteConversation={onDeleteConversation}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
