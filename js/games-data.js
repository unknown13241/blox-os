/*
 * Local fallback games.
 *
 * The main catalog is loaded from the Lumin SDK (1,100+ real browser games —
 * the same titles shown in the reference screenshots). Those games are fetched
 * at runtime in app.js; this file only holds games served by this site, so
 * something is always playable even if the Lumin CDN is unavailable.
 */
window.DEFAULT_GAMES = [
  {
    id: 'snake',
    name: 'Neon Snake',
    description: 'Eat the dots, grow longer, and avoid hitting yourself.',
    category: 'Local',
    icon: '🐍',
    url: 'games/snake.html',
    proxied: false,
    external: false,
    local: true,
  },
  {
    id: 'memory',
    name: 'Memory Flip',
    description: 'Flip cards and match all the pairs in as few moves as you can.',
    category: 'Local',
    icon: '🧠',
    url: 'games/memory.html',
    proxied: false,
    external: false,
    local: true,
  },
  {
    id: 'sketch',
    name: 'Sketch Pad',
    description: 'A quick canvas to doodle, draw, and let your ideas loose.',
    category: 'Local',
    icon: '🎨',
    url: 'games/sketch.html',
    proxied: false,
    external: false,
    local: true,
  },
];
