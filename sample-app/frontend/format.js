export function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function formatDate(iso) {
  return new Date(iso).toISOString().slice(0, 10);
}

export function badge(text, kind) {
  return `<span class="badge badge-${kind}">${escapeHtml(text)}</span>`;
}
