'use client';

import { Trash2, Star, Pencil } from 'lucide-react';
import { useState } from 'react';

import { useConfirm } from '@/components/ConfirmDialog';
import { AuthorKind } from '@/lib/enum';
import {
  useAddAuthorMutation,
  useAuthorsQuery,
  useDeleteAuthorMutation,
  useMakeDefaultAuthorMutation,
  useUpdateAuthorMutation,
  type Author,
} from '@/lib/queries/authors';

export default function SettingsPage() {
  const { data, isLoading, error } = useAuthorsQuery();
  const authors = data?.authors ?? [];
  const gitSuggestion = data?.gitSuggestion ?? null;
  const confirm = useConfirm();

  const updateAuthor = useUpdateAuthorMutation();
  const deleteAuthorMutation = useDeleteAuthorMutation();
  const makeDefaultMutation = useMakeDefaultAuthorMutation();
  const addAuthorMutation = useAddAuthorMutation();

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');

  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<AuthorKind>(AuthorKind.Human);
  const [newEmail, setNewEmail] = useState('');

  const startEdit = (author: Author) => {
    setEditingId(author.id);
    setEditName(author.name);
    setEditEmail(author.email || '');
  };

  const applyGitSuggestion = () => {
    if (!gitSuggestion) return;
    setEditName(gitSuggestion.name || '');
    setEditEmail(gitSuggestion.email || '');
  };

  const saveEdit = (id: number) => {
    updateAuthor.mutate(
      { id, name: editName.trim(), email: editEmail.trim() || null },
      {
        onSuccess: () => setEditingId(null),
        onError: (e) => alert(e.message),
      },
    );
  };

  const deleteAuthor = async (id: number) => {
    if (!(await confirm('Delete this author?'))) return;
    deleteAuthorMutation.mutate(id, { onError: (e) => alert(e.message) });
  };

  const makeDefault = (id: number) => {
    makeDefaultMutation.mutate(id, { onError: (e) => alert(e.message) });
  };

  const addAuthor = () => {
    if (!newName.trim()) return;
    addAuthorMutation.mutate(
      { name: newName.trim(), kind: newKind, email: newEmail.trim() || null },
      {
        onSuccess: () => {
          setNewName('');
          setNewEmail('');
        },
        onError: (e) => alert(e.message),
      },
    );
  };

  if (isLoading)
    return (
      <div className="settings-page">
        <p>Loading...</p>
      </div>
    );

  return (
    <div className="settings-page">
      <h1>Settings</h1>
      <section className="authors-section">
        <h2>Authors</h2>
        {error && <p className="error-text">{error.message}</p>}
        <table className="authors-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Name</th>
              <th>Email</th>
              <th>Default</th>
              <th aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody>
            {authors.map((author) => {
              const isDefault =
                author.kind === AuthorKind.Human ? author.isDefaultHuman : author.isDefaultAgent;
              const showGitHint =
                isDefault &&
                author.kind === AuthorKind.Human &&
                gitSuggestion &&
                (gitSuggestion.name !== author.name ||
                  (gitSuggestion.email || null) !== author.email);

              return (
                <tr key={author.id}>
                  <td>{author.kind}</td>
                  <td>
                    {editingId === author.id ? (
                      <input value={editName} onChange={(e) => setEditName(e.target.value)} />
                    ) : (
                      author.name
                    )}
                  </td>
                  <td>
                    {editingId === author.id ? (
                      <input value={editEmail} onChange={(e) => setEditEmail(e.target.value)} />
                    ) : (
                      author.email || <span className="dim">-</span>
                    )}
                  </td>
                  <td>{isDefault && <span className="default-badge">default</span>}</td>
                  <td className="actions-cell">
                    {editingId === author.id ? (
                      <>
                        {showGitHint && (
                          <button onClick={applyGitSuggestion} className="hint-btn">
                            git config says &quot;{gitSuggestion?.name}&quot; - use this?
                          </button>
                        )}
                        <button onClick={() => saveEdit(author.id)}>Save</button>
                        <button onClick={() => setEditingId(null)} className="cancel">
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => startEdit(author)} title="Edit">
                          <Pencil size={14} />
                        </button>
                        {!isDefault && (
                          <button onClick={() => makeDefault(author.id)} title="Make default">
                            <Star size={14} />
                          </button>
                        )}
                        <button
                          onClick={() => deleteAuthor(author.id)}
                          className="delete-btn"
                          title="Delete"
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="add-author-form">
          <input placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <select value={newKind} onChange={(e) => setNewKind(e.target.value as AuthorKind)}>
            <option value="human">human</option>
            <option value="agent">agent</option>
          </select>
          <input
            placeholder="Email (optional)"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
          />
          <button onClick={addAuthor} className="primary">
            Add Author
          </button>
        </div>
      </section>
    </div>
  );
}
