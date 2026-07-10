'use client';

import { Trash2, Star, Pencil } from 'lucide-react';
import { useState, useEffect } from 'react';

import { useConfirm } from '@/components/ConfirmDialog';

interface Author {
  id: number;
  kind: 'human' | 'agent';
  name: string;
  email: string | null;
  isDefaultHuman: boolean;
  isDefaultAgent: boolean;
}

interface GitSuggestion {
  name: string | null;
  email: string | null;
}

export default function SettingsPage() {
  const [authors, setAuthors] = useState<Author[]>([]);
  const [gitSuggestion, setGitSuggestion] = useState<GitSuggestion | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');

  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<'human' | 'agent'>('human');
  const [newEmail, setNewEmail] = useState('');
  const confirm = useConfirm();

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/authors');
      if (!res.ok) throw new Error('Failed to load authors');
      const data = await res.json();
      setAuthors(data.authors);
      setGitSuggestion(data.gitSuggestion);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error loading authors');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

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

  const saveEdit = async (id: number) => {
    try {
      const res = await fetch(`/api/authors/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName.trim(), email: editEmail.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update author');
      setEditingId(null);
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Error updating author');
    }
  };

  const deleteAuthor = async (id: number) => {
    if (!confirm('Delete this author?')) return;
    try {
      const res = await fetch(`/api/authors/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete author');
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Error deleting author');
    }
  };

  const makeDefault = async (id: number) => {
    try {
      const res = await fetch(`/api/authors/${id}/default`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to set default');
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Error setting default');
    }
  };

  const addAuthor = async () => {
    if (!newName.trim()) return;
    try {
      const res = await fetch('/api/authors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          kind: newKind,
          email: newEmail.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add author');
      setNewName('');
      setNewEmail('');
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Error adding author');
    }
  };

  if (loading)
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
        {error && <p className="error-text">{error}</p>}
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
                author.kind === 'human' ? author.isDefaultHuman : author.isDefaultAgent;
              const showGitHint =
                isDefault &&
                author.kind === 'human' &&
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
          <select value={newKind} onChange={(e) => setNewKind(e.target.value as 'human' | 'agent')}>
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
