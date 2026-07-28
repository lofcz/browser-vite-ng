/**
 * Minimal VS Code Seti-style file icons as inline SVG (no icon font / sprite
 * download needed). Colors follow the Seti theme's per-language hues.
 */

export function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d={expanded ? 'M5 6l3 4 3-4H5z' : 'M6 5l4 3-4 3V5z'}
        fill="currentColor"
      />
    </svg>
  );
}

const FOLDER_OPEN = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path
      d="M1.5 3.5A1.5 1.5 0 013 2h2.6l1.2 1.5H13a1.5 1.5 0 011.5 1.5v.5H4.1a2 2 0 00-1.9 1.4L1.5 10V3.5z"
      fill="#c09553"
    />
    <path d="M2.6 7h11.9a1 1 0 01.95 1.32l-1.6 4.5A1.5 1.5 0 0112.4 14H2a1 1 0 01-.95-1.32l.6-4.5A1.5 1.5 0 013.1 7h-.5z" fill="#dcb67a" opacity=".9"/>
  </svg>
);
const FOLDER_CLOSED = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path
      d="M1.5 3.5A1.5 1.5 0 013 2h2.6l1.2 1.5H13a1.5 1.5 0 011.5 1.5V12a1.5 1.5 0 01-1.5 1.5H3A1.5 1.5 0 011.5 12V3.5z"
      fill="#c09553"
    />
  </svg>
);

function file(color: string, letter?: string) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 1.5h5.5L13 5v8.5a1 1 0 01-1 1H4a1 1 0 01-1-1v-11a1 1 0 011-1z" fill={color} opacity=".18"/>
      <path d="M9.5 1.5L13 5H9.5V1.5z" fill={color} opacity=".5"/>
      {letter && (
        <text x="8" y="12.2" textAnchor="middle" fontSize="7.5" fontWeight="700" fill={color} fontFamily="monospace">
          {letter}
        </text>
      )}
    </svg>
  );
}

export function FileIcon({ name, folder, expanded }: { name: string; folder: boolean; expanded?: boolean }) {
  if (folder) return expanded ? FOLDER_OPEN : FOLDER_CLOSED;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'tsx':
      return file('#519aba', '⚛');
    case 'ts':
      return file('#519aba', 'TS');
    case 'jsx':
      return file('#cbcb41', '⚛');
    case 'js':
      return file('#cbcb41', 'JS');
    case 'css':
      return file('#563d7c', '#');
    case 'json':
      return file('#cbcb41', '{}');
    case 'html':
      return file('#e37933', '<>');
    case 'md':
      return file('#519aba', 'M↓');
    case 'svg':
      return file('#a074c4', '◆');
    default:
      return file('#8a8a8a');
  }
}
