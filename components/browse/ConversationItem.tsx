'use client';

import {
  Bot,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  AlertCircle,
  File,
  GitCommit,
  Loader2,
  MessageSquare,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';

import type { Conversation, ConversationMessage } from '@/app/browse/conversations/types';
import { AuthorKind, ConversationStatus } from '@/lib/enum';

function getStatusIcon(conv: Conversation) {
  if (conv.status === ConversationStatus.Resolved) {
    return <CheckCircle size={14} className="status-icon resolved" />;
  }
  if (conv.status === ConversationStatus.Orphaned || !conv.file_exists) {
    return <AlertCircle size={14} className="status-icon orphaned" />;
  }
  return <Clock size={14} className="status-icon active" />;
}

function formatDate(dateStr: string) {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface ConversationItemProps {
  conv: Conversation;
  repoPath: string;
  isExpanded: boolean;
  messages: ConversationMessage[] | undefined;
  replyContent: string;
  claudeResponding: string | null;
  claudeError: string | null;
  onToggle: () => void;
  onReplyChange: (value: string) => void;
  onAddReply: (conversationUuid: string) => void;
  onRespondWithClaude: (conversationUuid: string, autoCommit: boolean) => void;
  onResolveConversation: (uuid: string) => void;
  onDeleteConversation: (uuid: string) => void;
}

export default function ConversationItem({
  conv,
  repoPath,
  isExpanded,
  messages,
  replyContent,
  claudeResponding,
  claudeError,
  onToggle,
  onReplyChange,
  onAddReply,
  onRespondWithClaude,
  onResolveConversation,
  onDeleteConversation,
}: ConversationItemProps) {
  return (
    <div className={`conversation-item ${conv.status} ${isExpanded ? 'expanded' : ''}`}>
      <div
        className="conversation-summary"
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <div className="summary-left">
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {getStatusIcon(conv)}
          <span className="line-number">Line {conv.current_line_number || conv.line_number}</span>
          {conv.current_line_number && conv.current_line_number !== conv.line_number && (
            <span className="line-moved">(was {conv.line_number})</span>
          )}
        </div>
        <div className="summary-right">
          <span className="message-count">
            <MessageSquare size={12} />
            {conv.message_count || 0}
          </span>
          <span className="date">{formatDate(conv.created_at)}</span>
        </div>
      </div>

      {conv.latest_message && !isExpanded && (
        <div className="conversation-preview">
          <span className="preview-author">{conv.latest_message.author}:</span>
          <span className="preview-content">{conv.latest_message.content}</span>
        </div>
      )}

      {isExpanded && messages && (
        <div className="conversation-messages">
          {messages.map((msg) => (
            <div
              key={msg.uuid}
              className={`message ${msg.author_kind === AuthorKind.Agent ? 'message-claude' : 'message-user'}`}
            >
              <span className="message-author">{msg.author}</span>
              <span className="message-content">{msg.content}</span>
              <span className="message-time">{formatDate(msg.created_at)}</span>
            </div>
          ))}
          {conv.status !== ConversationStatus.Resolved && (
            <div className="reply-form-inline">
              <textarea
                placeholder="Write a reply..."
                value={replyContent}
                onChange={(e) => onReplyChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    onAddReply(conv.uuid);
                  }
                }}
                onClick={(e) => e.stopPropagation()}
              />
              <button
                className="send-reply-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onAddReply(conv.uuid);
                }}
              >
                Send
              </button>
            </div>
          )}
          {claudeError && isExpanded && <div className="claude-status-message">{claudeError}</div>}
          <div className="conversation-actions">
            {conv.status !== ConversationStatus.Resolved && conv.file_exists && (
              <>
                <button
                  className="claude-respond-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRespondWithClaude(conv.uuid, false);
                  }}
                  disabled={claudeResponding === conv.uuid}
                >
                  {claudeResponding === conv.uuid ? (
                    <Loader2 size={14} className="spinning" />
                  ) : (
                    <Bot size={14} />
                  )}
                  {claudeResponding === conv.uuid ? 'Thinking...' : 'Ask Claude'}
                </button>
                <button
                  className="claude-respond-commit-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRespondWithClaude(conv.uuid, true);
                  }}
                  disabled={claudeResponding === conv.uuid}
                >
                  {claudeResponding === conv.uuid ? (
                    <Loader2 size={14} className="spinning" />
                  ) : (
                    <GitCommit size={14} />
                  )}
                  Ask & Commit
                </button>
              </>
            )}
            {conv.status !== ConversationStatus.Resolved && (
              <button
                className="resolve-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onResolveConversation(conv.uuid);
                }}
              >
                <CheckCircle size={14} />
                Resolve
              </button>
            )}
            <button
              className="delete-btn"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteConversation(conv.uuid);
              }}
            >
              <Trash2 size={14} />
              Delete
            </button>
            {conv.file_exists && (
              <Link
                href={`/browse?repo=${encodeURIComponent(repoPath)}&file=${encodeURIComponent(conv.file_path)}&line=${conv.current_line_number || conv.line_number}`}
                className="view-file-btn"
                onClick={(e) => e.stopPropagation()}
              >
                <File size={14} />
                View in File
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
