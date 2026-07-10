import { AuthorKind, ConversationStatus } from '@/lib/enum';

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: TreeNode[];
  conversationCount?: number;
}

export interface ConversationMessage {
  uuid: string;
  author: string;
  author_kind: AuthorKind;
  content: string;
  created_at: string;
}

export interface Conversation {
  uuid: string;
  line_number: number;
  current_line_number: number | null;
  status: ConversationStatus;
  message_count: number;
  latest_message: ConversationMessage | null;
}

export interface ConversationWithMessages {
  conversation: {
    uuid: string;
    file_path: string;
    line_number: number;
    current_line_number: number | null;
    status: ConversationStatus;
  };
  messages: ConversationMessage[];
}
