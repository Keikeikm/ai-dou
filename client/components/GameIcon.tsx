const shapes = {
  settings: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8', 'm9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 2 2 3-2 3 1 2-3-1-3 2-2-2-3-3-1-1-3z'],
  history: ['M8 6h12M8 12h12M8 18h12', 'M3 6h1M3 12h1M3 18h1'],
  response: ['M4 4h16v12H9l-5 4z', 'M8 8h8M8 12h5'],
  replay: ['M4 10a8 8 0 1 1 1 8', 'M4 4v6h6', 'M12 8v5l3 2'],
  cards: ['M5 5h12v16H5z', 'm9 5 1-3 11 3-3 12', 'm11 9 3 4-3 4-3-4z'],
  play: ['m8 5 11 7-11 7z'],
  pause: ['M8 5v14M16 5v14'],
} as const;

export function GameIcon({ name }: { name: keyof typeof shapes }) {
  return <svg className="game-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {shapes[name].map((shape) => <path key={shape} d={shape} />)}
  </svg>;
}
