import { createContext } from 'react';

// The comment thread a "View in Files" link last pointed at, if any. A
// context rather than a prop because the threads it has to reach sit several
// components deep (inside FileDiffCard's diff rows and CommitMessagePanel),
// and only CollapsibleCommentThread reads it.
export const TargetedCommentContext = createContext<string | null>(null);
