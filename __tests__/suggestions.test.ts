import { describe, expect, it } from 'vitest';

import { parseComment } from '../lib/suggestions';

describe('parseComment', () => {
  it('returns a single prose segment when there is no fence', () => {
    expect(parseComment('Just a plain comment, no suggestion here.')).toEqual([
      { type: 'prose', text: 'Just a plain comment, no suggestion here.' },
    ]);
  });

  it('parses a fence with no surrounding prose', () => {
    const content = '```suggestion\nfunction fixed() {\n  return 1;\n}\n```';
    expect(parseComment(content)).toEqual([
      { type: 'suggestion', lines: ['function fixed() {', '  return 1;', '}'] },
    ]);
  });

  it('parses prose before the fence', () => {
    const content = 'This is off by one.\n\n```suggestion\nfor (let i = 0; i < n - 1; i++) {\n```';
    expect(parseComment(content)).toEqual([
      { type: 'prose', text: 'This is off by one.' },
      { type: 'suggestion', lines: ['for (let i = 0; i < n - 1; i++) {'] },
    ]);
  });

  it('keeps prose that comes after the fence', () => {
    const content = '```suggestion\nfixedLine();\n```\n\nAlso please add a test.';
    expect(parseComment(content)).toEqual([
      { type: 'suggestion', lines: ['fixedLine();'] },
      { type: 'prose', text: 'Also please add a test.' },
    ]);
  });

  it('parses multiple fences as separate ordered segments', () => {
    const content =
      'First one.\n\n```suggestion\nfirst();\n```\n\nAnd a second.\n\n```suggestion\nsecond();\n```';
    expect(parseComment(content)).toEqual([
      { type: 'prose', text: 'First one.' },
      { type: 'suggestion', lines: ['first();'] },
      { type: 'prose', text: 'And a second.' },
      { type: 'suggestion', lines: ['second();'] },
    ]);
  });

  it('omits an empty prose segment between two adjacent fences', () => {
    const content = '```suggestion\nfirst();\n```\n\n```suggestion\nsecond();\n```';
    expect(parseComment(content)).toEqual([
      { type: 'suggestion', lines: ['first();'] },
      { type: 'suggestion', lines: ['second();'] },
    ]);
  });

  it('treats an empty fence as deleting the range', () => {
    const content = 'Just delete this line.\n\n```suggestion\n```';
    expect(parseComment(content)).toEqual([
      { type: 'prose', text: 'Just delete this line.' },
      { type: 'suggestion', lines: [] },
    ]);
  });

  it('preserves indentation across multiple lines', () => {
    const content = '```suggestion\nif (x) {\n  return 1;\n} else {\n  return 2;\n}\n```';
    expect(parseComment(content)).toEqual([
      { type: 'suggestion', lines: ['if (x) {', '  return 1;', '} else {', '  return 2;', '}'] },
    ]);
  });

  it('returns an empty array for empty content', () => {
    expect(parseComment('')).toEqual([]);
  });
});
