import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import AuthorBadge from '../components/pr/AuthorBadge';
import { AuthorKind } from '../lib/enum';

describe('AuthorBadge', () => {
  it("marks an agent's comment as an AI review", () => {
    const { container } = render(
      <AuthorBadge comment={{ author: 'claude', author_kind: AuthorKind.Agent }} />,
    );
    expect(container.textContent).toBe('claude · AI review');
  });

  it("renders nothing for a human's comment", () => {
    const { container } = render(
      <AuthorBadge comment={{ author: 'Jo', author_kind: AuthorKind.Human }} />,
    );
    expect(container.innerHTML).toBe('');
  });
});
