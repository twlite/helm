export const MouseButton = {
  Left: '1',
  Middle: '2',
  Right: '3',
} as const;

export type MouseButton =
  | keyof typeof MouseButton
  | Lowercase<keyof typeof MouseButton>
  | (typeof MouseButton)[keyof typeof MouseButton];

export const KeyAlias: Record<string, string> = {
  command: 'super',
  cmd: 'super',
  meta: 'super',
  win: 'super',
  windows: 'super',
  option: 'alt',
  control: 'ctrl',
  return: 'Return',
  enter: 'Return',
  esc: 'Escape',
  pgup: 'Page_Up',
  pgdn: 'Page_Down',
  pageup: 'Page_Up',
  pagedown: 'Page_Down',
};
