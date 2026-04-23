// Static stylesheet — no runtime interpolation.
// The accent colour is injected via the CSS custom property --accent,
// which is set as an inline style on <html> in page.tsx.
export const STATIC_STYLES = `
  body {
    font-family: system-ui, -apple-system, sans-serif;
    margin: 0; padding: 2rem;
    background: #f7f8fa; color: #1a1f2c;
  }
  h1 { font-size: 1.5rem; margin: 0 0 1.5rem; }
  .grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); max-width: 900px; }
  form.tile { margin: 0; }
  button.tile {
    width: 100%; text-align: left; padding: 1rem;
    background: #fff; border: 1px solid #d0d5dd; border-radius: 8px;
    cursor: pointer; font: inherit;
  }
  button.tile:hover { border-color: var(--accent); }
  button.tile:focus { outline: 2px solid var(--accent); outline-offset: 2px; }
  .tile .name { font-weight: 600; margin-bottom: 0.25rem; }
  .tile .email { color: #667085; font-size: 0.875rem; }
`.trim();
