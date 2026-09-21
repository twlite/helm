import type { SVGProps } from 'react';

export type IconName =
  | 'activity'
  | 'archive'
  | 'arrow-up'
  | 'brain'
  | 'check'
  | 'chevron-down'
  | 'chevron-right'
  | 'circle'
  | 'clock'
  | 'cloud'
  | 'copy'
  | 'database'
  | 'file'
  | 'flask'
  | 'folder'
  | 'memory'
  | 'menu'
  | 'message'
  | 'monitor'
  | 'pause'
  | 'play'
  | 'plus'
  | 'refresh'
  | 'search'
  | 'send'
  | 'server'
  | 'settings'
  | 'spark'
  | 'square'
  | 'target'
  | 'trash'
  | 'triangle'
  | 'x';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'name'> & {
  name: IconName;
  size?: number;
};

const paths: Record<IconName, string[]> = {
  activity: ['M3 12h3l2-7 4 14 2-7h7'],
  archive: ['M4 7h16', 'M6 7v12h12V7', 'M9 11h6', 'M5 4h14v3H5z'],
  'arrow-up': ['M12 19V5', 'm5 12 7-7 7 7'],
  brain: ['M9.5 4.5A3.5 3.5 0 0 0 6 8a3 3 0 0 0 0 6 3.5 3.5 0 0 0 3.5 3.5', 'M14.5 4.5A3.5 3.5 0 0 1 18 8a3 3 0 0 1 0 6 3.5 3.5 0 0 1-3.5 3.5', 'M12 5v14', 'M7 10h3', 'M14 10h3'],
  check: ['m5 12 4 4L19 6'],
  'chevron-down': ['m6 9 6 6 6-6'],
  'chevron-right': ['m9 6 6 6-6 6'],
  circle: ['M12 12h.01'],
  clock: ['M12 7v5l3 2', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z'],
  cloud: ['M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6 11a3.5 3.5 0 0 0 1 7Z'],
  copy: ['M8 8h10v12H8z', 'M6 16H4V4h10v2'],
  database: ['M4 5c0 1.1 3.6 2 8 2s8-.9 8-2-3.6-2-8-2-8 .9-8 2Z', 'M4 5v7c0 1.1 3.6 2 8 2s8-.9 8-2V5', 'M4 12v7c0 1.1 3.6 2 8 2s8-.9 8-2v-7'],
  file: ['M6 3h8l4 4v14H6z', 'M14 3v5h5', 'M9 13h6', 'M9 17h6'],
  flask: ['M9 3h6', 'M10 3v6l-5 8a3 3 0 0 0 2.6 4.5h8.8A3 3 0 0 0 19 17l-5-8V3', 'M8 16h8'],
  folder: ['M3 6h6l2 2h10v10H3z'],
  memory: ['M6 6h12v12H6z', 'M9 3v3', 'M15 3v3', 'M9 18v3', 'M15 18v3', 'M3 9h3', 'M3 15h3', 'M18 9h3', 'M18 15h3'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  message: ['M4 5h16v11H8l-4 4z', 'M8 9h8', 'M8 12h5'],
  monitor: ['M4 4h16v12H4z', 'M8 20h8', 'M12 16v4'],
  pause: ['M8 5v14', 'M16 5v14'],
  play: ['m8 5 11 7-11 7z'],
  plus: ['M12 5v14', 'M5 12h14'],
  refresh: ['M20 11a8 8 0 1 0 1 4', 'M20 5v6h-6'],
  search: ['m20 20-4.5-4.5', 'M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13Z'],
  send: ['m3 4 18 8-18 8 3-8z', 'M6 12h15'],
  server: ['M4 4h16v6H4z', 'M4 14h16v6H4z', 'M7 7h.01', 'M7 17h.01'],
  settings: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M4 12H2', 'M22 12h-2', 'm4.9 19.1 1.4-1.4', 'm17.7 6.3 1.4-1.4', 'M12 4V2', 'M12 22v-2'],
  spark: ['m12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4z', 'm19 17 .5 2.5L22 20l-2.5.5L19 23l-.5-2.5L16 20l2.5-.5z'],
  square: ['M5 5h14v14H5z'],
  target: ['M12 3v3', 'M12 18v3', 'M3 12h3', 'M18 12h3', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M7 7l1 14h8l1-14', 'M9 7V4h6v3'],
  triangle: ['m12 4 9 16H3z'],
  x: ['m6 6 12 12', 'm18 6-12 12'],
};

export function Icon({ name, size = 16, strokeWidth = 1.8, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      {...props}
    >
      {paths[name].map((d) => (
        <path d={d} key={d} />
      ))}
    </svg>
  );
}
