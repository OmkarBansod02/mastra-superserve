import { describe, expect, it } from 'vitest';
import { normalizeKey, parseMouseLocation, pngSize, shellQuote } from '../src/utils.js';
import { fakePng } from './fakes.js';

describe('normalizeKey', () => {
  it.each([
    ['a', ['a']],
    ['A', ['A']],
    ['7', ['7']],
    ['Tab', ['Tab']],
    ['Backspace', ['BackSpace']],
    ['Del', ['Delete']],
    ['PgUp', ['Page_Up']],
    ['space', ['space']],
    [' ', ['space']],
    ['+', ['plus']],
    ['F12', ['F12']],
    ['f25', ['F25']],
    ['shift', ['Shift_L']],
    ['Return', ['Return']],
    ['Page_Up', ['Page_Up']],
    ['KP_Enter', ['KP_Enter']],
    ['alt+F4', ['alt', 'F4']],
    [' ctrl + c ', ['ctrl', 'c']],
    [['Meta', 'Shift', 'P'], ['super', 'shift', 'p']],
    [['ctrl', 'alt'], ['ctrl', 'Alt_L']],
  ])('%j → %j', (input, expected) => {
    expect(normalizeKey(input as string | string[])).toEqual(expected);
  });

  it.each([[''], [[]], [['ctrl', '']], ['ctrl+'], ['hello world'], ['ctrl+a b'], [['x', 'y']], ['é']])(
    'rejects %j',
    (input) => {
      expect(() => normalizeKey(input as string | string[])).toThrow();
    },
  );
});

describe('shellQuote', () => {
  it('leaves safe tokens alone and single-quotes the rest', () => {
    expect(shellQuote('/usr/bin/env')).toBe('/usr/bin/env');
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('')).toBe("''");
  });
});

describe('pngSize', () => {
  it('reads IHDR dimensions', () => {
    expect(pngSize(fakePng(1280, 800))).toEqual({ width: 1280, height: 800 });
  });
  it('returns null for non-PNG or truncated data', () => {
    expect(pngSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
    expect(pngSize(fakePng(10, 10).slice(0, 20))).toBeNull();
    expect(pngSize(fakePng(0, 10))).toBeNull();
  });
});

describe('parseMouseLocation', () => {
  it('parses xdotool --shell output', () => {
    expect(parseMouseLocation('X=0\nY=0\nSCREEN=0\nWINDOW=1\n')).toEqual({ x: 0, y: 0 });
    expect(parseMouseLocation('X=896\r\nY=480\r\n')).toEqual({ x: 896, y: 480 });
  });
  it('returns null when X or Y is missing or malformed', () => {
    expect(parseMouseLocation('X=1\n')).toBeNull();
    expect(parseMouseLocation('X=a\nY=2')).toBeNull();
    expect(parseMouseLocation('')).toBeNull();
  });
});
