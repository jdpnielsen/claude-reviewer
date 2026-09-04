'use client';

import type { Dispatch, SetStateAction } from 'react';

import { CommentResolutionMode } from '@/lib/enum';

interface ResolutionModeSelectProps {
  value: CommentResolutionMode;
  onChange: Dispatch<SetStateAction<CommentResolutionMode>>;
}

export const RESOLUTION_MODE_LABELS: Record<CommentResolutionMode, string> = {
  [CommentResolutionMode.Fix]: 'Just fix it',
  [CommentResolutionMode.Discuss]: "Let's discuss",
  [CommentResolutionMode.FixIfAgreed]: 'Fix if you agree',
};

export default function ResolutionModeSelect({ value, onChange }: ResolutionModeSelectProps) {
  return (
    <select
      className="resolution-mode-select"
      value={value}
      onChange={(e) => onChange(e.target.value as CommentResolutionMode)}
      title="How should this comment be handled?"
    >
      {Object.values(CommentResolutionMode).map((mode) => (
        <option key={mode} value={mode}>
          {RESOLUTION_MODE_LABELS[mode]}
        </option>
      ))}
    </select>
  );
}
