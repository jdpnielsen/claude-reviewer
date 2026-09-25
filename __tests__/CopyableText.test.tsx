import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';

import CopyableText from '@/components/CopyableText';

describe('CopyableText', () => {
  type WriteText = (text: string) => Promise<void>;
  let writeText: Mock<WriteText>;

  beforeEach(() => {
    writeText = vi.fn<WriteText>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

  test('copies the full text, not the displayed form', () => {
    render(<CopyableText text="abc1234def5678">abc1234</CopyableText>);
    fireEvent.click(screen.getByRole('button', { name: /abc1234/ }));
    expect(writeText).toHaveBeenCalledWith('abc1234def5678');
  });

  test('shows copied feedback once the clipboard write succeeds', async () => {
    render(<CopyableText text="main">main</CopyableText>);
    fireEvent.click(screen.getByRole('button', { name: /main/ }));
    expect(await screen.findByLabelText('Copied')).toBeInTheDocument();
  });

  test('shows no copied feedback when the clipboard write fails', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    render(<CopyableText text="main">main</CopyableText>);
    fireEvent.click(screen.getByRole('button', { name: /main/ }));
    await Promise.resolve();
    expect(screen.queryByLabelText('Copied')).not.toBeInTheDocument();
  });
});
