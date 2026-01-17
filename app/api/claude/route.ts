import { NextRequest, NextResponse } from 'next/server';
import { requestFixes, generatePRMetadata, respondToConversation, commitChanges } from '@/lib/claude';
import { getRepoConversationWithMessages, addRepoConversationMessage } from '@/lib/database';

export async function POST(req: NextRequest) {
    const body = await req.json();
    const { action } = body;

    try {
        if (action === 'fix') {
            const { diff, comments, repoPath } = body;
            const patch = await requestFixes({ repoInfo: repoPath, diff, comments });
            return NextResponse.json({ patch });
        }

        if (action === 'metadata') {
            const { diff } = body;
            const metadata = await generatePRMetadata(diff);
            return NextResponse.json(metadata);
        }

        if (action === 'respond') {
            // Respond to a conversation with Claude (with edit capability)
            const { conversationUuid, allowEdits = true, autoCommit = false, push = false, async: runAsync = false } = body;

            if (!conversationUuid) {
                return NextResponse.json({ error: 'conversationUuid is required' }, { status: 400 });
            }

            // Get the conversation and messages
            const convData = getRepoConversationWithMessages(conversationUuid);
            if (!convData) {
                return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
            }

            const { conversation, messages } = convData;
            const lineNumber = conversation.current_line_number || conversation.line_number;

            // If async mode, spawn the process and return immediately
            if (runAsync) {
                // Fire and forget - don't await
                (async () => {
                    try {
                        const result = await respondToConversation({
                            repoPath: conversation.repo_path,
                            filePath: conversation.file_path,
                            lineNumber,
                            messages: messages.map(m => ({ author: m.author, content: m.content })),
                            allowEdits
                        });

                        if (!result.error) {
                            addRepoConversationMessage(conversationUuid, result.response, 'claude');

                            if (autoCommit && result.hasChanges) {
                                await commitChanges({
                                    repoPath: conversation.repo_path,
                                    message: `Address feedback: ${conversation.file_path}:${lineNumber}`,
                                    push
                                });
                            }
                        }
                    } catch (e) {
                        console.error('Background Claude response error:', e);
                    }
                })();

                return NextResponse.json({ status: 'processing', conversationUuid });
            }

            // Synchronous mode - wait for response
            const result = await respondToConversation({
                repoPath: conversation.repo_path,
                filePath: conversation.file_path,
                lineNumber,
                messages: messages.map(m => ({ author: m.author, content: m.content })),
                allowEdits
            });

            if (result.error) {
                return NextResponse.json({ error: result.error }, { status: 500 });
            }

            // Save Claude's response to the database
            const messageUuid = addRepoConversationMessage(conversationUuid, result.response, 'claude');

            // Auto-commit if requested and there are changes
            let commitResult = null;
            if (autoCommit && result.hasChanges) {
                commitResult = await commitChanges({
                    repoPath: conversation.repo_path,
                    message: `Address feedback: ${conversation.file_path}:${lineNumber}`,
                    push
                });
            }

            return NextResponse.json({
                response: result.response,
                messageUuid,
                hasChanges: result.hasChanges,
                commit: commitResult
            });
        }

        if (action === 'commit') {
            // Commit and optionally push changes
            const { repoPath, message, push = false } = body;

            if (!repoPath || !message) {
                return NextResponse.json({ error: 'repoPath and message are required' }, { status: 400 });
            }

            const result = await commitChanges({ repoPath, message, push });

            if (!result.success) {
                return NextResponse.json({ error: result.error }, { status: 500 });
            }

            return NextResponse.json(result);
        }

        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}
