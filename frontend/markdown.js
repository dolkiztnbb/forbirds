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
// Post references are numeric local links, not arbitrary HTML/URLs. Never nest links.
md.inline.ruler.before('text', 'post_reference', (state, silent) => {
  if (state.linkLevel > 0 || state.src[state.pos] !== '>' || state.src[state.pos - 1] === '>') return false;
  const match = /^>>([1-9][0-9]{0,8})(?![0-9A-Za-z_])/.exec(state.src.slice(state.pos, state.pos + 13));
  if (!match) return false;
  if (!silent) {
    const token = state.push('post_reference', 'a', 0); token.content = match[1];
  }
  state.pos += match[0].length; return true;
});
md.renderer.rules.post_reference = (tokens, index) => {
  const id = tokens[index].content;
  return `<a class="post-reference" href="/post.html?post=${id}#post-${id}">&gt;&gt;${id}</a>`;
};

// Resolve only exact, catalog-backed shortcode tokens. Code spans/fences, escapes,
// link destinations and raw HTML are never passed through string replacement.
md.inline.ruler.before('text', 'reaction_emoji', (state, silent) => {
  if (state.src[state.pos] !== ':') return false;
  const match = /^:([a-zA-Z0-9][a-zA-Z0-9_-]{0,63}):/.exec(state.src.slice(state.pos, state.pos + 66));
  const emoji = match && state.env.reactionEmojis?.get(match[1]);
  if (!emoji) return false;
  if (!silent) {
    const token = state.push('reaction_emoji', 'img', 0);
    token.content = match[0]; token.meta = emoji;
  }
  state.pos += match[0].length;
  return true;
});
md.renderer.rules.reaction_emoji = (tokens, index) => {
  const token = tokens[index], escape = md.utils.escapeHtml;
  return `<img class="post-emoji" src="${escape(token.meta.url)}" alt="${escape(token.content)}" title="${escape(token.meta.label)}" width="24" height="24" loading="lazy" decoding="async">`;
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
export function renderMarkdown(text, reactions = []) {
  const reactionEmojis = new Map();
  for (const reaction of reactions) {
    const match = /^([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\.(png|gif|jpe?g|webp)$/i.exec(reaction.file || '');
    if (!match || reaction.url !== '/static/reactions/' + encodeURIComponent(reaction.file) || reactionEmojis.has(match[1])) continue;
    reactionEmojis.set(match[1], { url: reaction.url, label: typeof reaction.label === 'string' ? reaction.label : match[1] });
  }
  return md.render(text, { reactionEmojis });
}
