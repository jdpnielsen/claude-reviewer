import { AuthorKind, ConversationStatus } from '@/lib/enum';

export interface ConversationMessage {
  uuid: string;
  author: string;
  author_kind: AuthorKind;
  content: string;
  created_at: string;
}

export interface Conversation {
  id: number;
  uuid: string;
  repo_path: string;
  file_path: string;
  line_number: number;
  current_line_number: number | null;
  status: ConversationStatus;
  file_exists: boolean;
  created_at: string;
  updated_at: string;
  message_count?: number;
  latest_message?: ConversationMessage | null;
}

export interface ConversationWithMessages {
  conversation: Conversation;
  messages: ConversationMessage[];
}
