// Radix Icons (@radix-ui/react-icons) — paths extracted for vanilla SVG use.
// https://icons.radix-ui.com/ · MIT License

import paths from './icon-paths.js';

const NS = 'http://www.w3.org/2000/svg';

/**
 * @param {keyof typeof paths} name
 * @param {{ size?: number, className?: string, label?: string }} [opts]
 */
export function icon(name, { size = 15, className = '', label } = {}) {
  const d = paths[name];
  if (!d) {
    console.warn('[StreamGrab] unknown icon:', name);
    const span = document.createElement('span');
    span.textContent = '•';
    span.setAttribute('aria-hidden', 'true');
    return span;
  }

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 15 15');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', label ? 'false' : 'true');
  if (className) svg.setAttribute('class', className);

  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('fill-rule', 'evenodd');
  path.setAttribute('clip-rule', 'evenodd');
  svg.append(path);

  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  }

  return svg;
}

/**
 * @param {keyof typeof paths} name
 * @param {string} [className]
 * @param {string} [label]
 * @param {string} [text]
 */
export function iconBtn(name, className = 'ghost', label = '', text = '') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  if (label) {
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }
  btn.append(icon(name, { size: 14, label: label || undefined }));
  if (text) {
    const span = document.createElement('span');
    span.textContent = text;
    btn.append(span);
  }
  return btn;
}

/** Tab button with icon + label */
export function tabBtn(name, text, tabId) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tab';
  btn.dataset.tab = tabId;
  btn.setAttribute('role', 'tab');
  btn.append(icon(name, { size: 14 }));
  const span = document.createElement('span');
  span.textContent = text;
  btn.append(span);
  return btn;
}

/** Inline status glyph (verified, error, etc.) */
export function statusIcon(name, className = '') {
  return icon(name, { size: 12, className });
}
