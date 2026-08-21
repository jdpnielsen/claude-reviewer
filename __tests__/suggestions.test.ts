import { describe, expect, it } from 'vitest';

import { parseSuggestion } from '../lib/suggestions';

describe('parseSuggestion', () => {
  it('returns null when there is no fence', () => {
    expect(parseSuggestion('Just a plain comment, no suggestion here.')).toBeNull();
  });

  it('parses a fence with no surrounding prose', () => {
    const content = '```suggestion\nfunction fixed() {\n  return 1;\n}\n```';
    const parsed = parseSuggestion(content);
    expect(parsed).not.toBeNull();
    expect(parsed?.prose).toBe('');
    expect(parsed?.lines).toEqual(['function fixed() {', '  return 1;', '}']);
  });

  it('parses prose before the fence', () => {
    const content = 'This is off by one.\n\n```suggestion\nfor (let i = 0; i < n - 1; i++) {\n```';
    const parsed = parseSuggestion(content);
    expect(parsed?.prose).toBe('This is off by one.');
    expect(parsed?.lines).toEqual(['for (let i = 0; i < n - 1; i++) {']);
  });

  it('keeps prose that comes after the fence', () => {
    const content = '```suggestion\nfixedLine();\n```\n\nAlso please add a test.';
    const parsed = parseSuggestion(content);
    expect(parsed?.lines).toEqual(['fixedLine();']);
    expect(parsed?.prose).toContain('Also please add a test.');
  });

  it('only parses the first of multiple fences', () => {
    const content = '```suggestion\nfirst();\n```\n\n```suggestion\nsecond();\n```';
    const parsed = parseSuggestion(content);
    expect(parsed?.lines).toEqual(['first();']);
    expect(parsed?.prose).toContain('second();');
  });

  it('treats an empty fence as deleting the range', () => {
    const content = 'Just delete this line.\n\n```suggestion\n```';
    const parsed = parseSuggestion(content);
    expect(parsed?.lines).toEqual([]);
  });

  it('preserves indentation across multiple lines', () => {
    const content = '```suggestion\nif (x) {\n  return 1;\n} else {\n  return 2;\n}\n```';
    const parsed = parseSuggestion(content);
    expect(parsed?.lines).toEqual(['if (x) {', '  return 1;', '} else {', '  return 2;', '}']);
  });
});
