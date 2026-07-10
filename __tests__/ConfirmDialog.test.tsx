import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';

import { ConfirmProvider, useConfirm } from '@/components/ConfirmDialog';

function TestHarness() {
  const confirm = useConfirm();
  const [result, setResult] = useState('none');

  const handleClick = async () => {
    const ok = await confirm('Delete this thing?', { danger: true });
    setResult(ok ? 'confirmed' : 'cancelled');
  };

  return (
    <div>
      <button onClick={handleClick}>Trigger</button>
      <div data-testid="result">{result}</div>
    </div>
  );
}

function renderHarness() {
  return render(
    <ConfirmProvider>
      <TestHarness />
    </ConfirmProvider>,
  );
}

describe('ConfirmDialog', () => {
  test('renders nothing when no confirmation is pending', () => {
    renderHarness();
    expect(screen.queryByText('Delete this thing?')).not.toBeInTheDocument();
  });

  test('shows the message and resolves true when Confirm is clicked', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('Trigger'));
    expect(await screen.findByText('Delete this thing?')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Confirm'));
    expect(await screen.findByTestId('result')).toHaveTextContent('confirmed');
  });

  test('resolves false when Cancel is clicked', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('Trigger'));
    await screen.findByText('Delete this thing?');

    fireEvent.click(screen.getByText('Cancel'));
    expect(await screen.findByTestId('result')).toHaveTextContent('cancelled');
  });

  test('resolves false when Escape is pressed', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('Trigger'));
    await screen.findByText('Delete this thing?');

    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    expect(await screen.findByTestId('result')).toHaveTextContent('cancelled');
  });

  test('resolves false when the backdrop is clicked', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('Trigger'));
    await screen.findByText('Delete this thing?');

    fireEvent.mouseDown(screen.getByTestId('confirm-backdrop'));
    expect(await screen.findByTestId('result')).toHaveTextContent('cancelled');
  });

  test('applies the danger class to the confirm button when danger: true', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('Trigger'));

    const confirmBtn = await screen.findByText('Confirm');
    expect(confirmBtn).toHaveClass('confirm-dialog-confirm-btn-danger');
  });
});
