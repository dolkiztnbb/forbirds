import MarkdownIt from 'markdown-it';

// Bundled locally: no CDN, raw HTML, external images, linkification or user plugins.
const md = new MarkdownIt({ html: false, breaks: true, linkify: false, maxNesting: 20 });
md.disable('image');
const baseValidateLink = md.validateLink.bind(md);
md.validateLink = href => {
  if (!baseValidateLink(href) || /[\u0000-\u0020\u007f]/.test(href)) return false;
  try { return ['http:', 'https:', 'mailto:'].includes(new URL(href, 'https://forbirds.invalid/').protocol); }
  catch { return false; }
};
md.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet('rel', 'nofollow noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
// Preserve the site's literal quote prefixes. This block rule runs AFTER fenced/
// indented code, so code samples are never interpreted as colored quotes.
md.block.ruler.before('blockquote', 'colored_quote', (state, startLine, endLine, silent) => {
  if (state.sCount[startLine] >= 4) return false;
  const start = state.bMarks[startLine];
  const color = { '>': 'green', '<': 'orange', '^': 'blue' }[state.src[start]];
  if (!color) return false;
  if (silent) return true;
  const token = state.push('colored_quote', 'div', 0);
  token.block = true;
  token.content = state.src.slice(start, state.eMarks[startLine]);
  token.meta = { color };
  token.map = [startLine, startLine + 1];
  state.line = startLine + 1;
  return true;
}, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
md.renderer.rules.colored_quote = (tokens, index, options, env) => {
  const token = tokens[index];
  return `<div class="quote-${token.meta.color}">${md.renderInline(token.content, env)}</div>\n`;
};

/** Output is generated exclusively by a fixed markdown-it configuration, never user HTML. */
export function renderMarkdown(text) { return md.render(text); }
