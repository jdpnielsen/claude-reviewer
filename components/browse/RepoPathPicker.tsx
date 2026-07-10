'use client';

interface RepoPathPickerProps {
  heading: string;
  description: string;
  submitLabel: string;
  inputPath: string;
  onInputPathChange: (value: string) => void;
  onSubmit: (path?: string) => void;
  recentRepos: string[];
}

// Shown when no repository path has been chosen yet: a path input plus a
// shortcut list of recently-browsed repos. Shared by /browse and
// /browse/conversations, which only differ in heading/description/button text.
export default function RepoPathPicker({
  heading,
  description,
  submitLabel,
  inputPath,
  onInputPathChange,
  onSubmit,
  recentRepos,
}: RepoPathPickerProps) {
  return (
    <div className="repo-input-section">
      <h1>{heading}</h1>
      <p>{description}</p>
      <div className="repo-input-form">
        <input
          type="text"
          placeholder="/path/to/your/repo"
          value={inputPath}
          onChange={(e) => onInputPathChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
        />
        <button onClick={() => onSubmit()}>{submitLabel}</button>
      </div>
      {recentRepos.length > 0 && (
        <div className="recent-repos">
          <p className="recent-repos-label">Recent repositories:</p>
          <div className="recent-repos-list">
            {recentRepos.map((path) => (
              <button key={path} className="recent-repo-btn" onClick={() => onSubmit(path)}>
                {path.split('/').pop()}
                <span className="recent-repo-path">{path}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
