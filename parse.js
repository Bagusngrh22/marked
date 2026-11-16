// parse.js — a fast CommonMark 0.31.2 + GFM renderer.
//
// An original, streaming implementation: markdown is scanned into small
// block records (no token tree), link reference definitions are collected
// for the whole document first, and HTML is emitted directly while inline
// content is rendered. The grammar (regular expressions and the exact
// delimiter rules) follows the behaviour of marked 18.1.3 with its
// default options (gfm on, breaks off, pedantic off, async off), whose
// output this module must reproduce byte for byte; marked is MIT licensed
// (Copyright (c) 2018+, MarkedJS; Copyright (c) 2011-2018, Christopher
// Jeffrey) and its grammar is the reference for the rules below.
//
// Deterministic: no clock, no environment, no randomness, no cache kept
// between parse() calls. Dependency-free: only the language itself.

const _tag = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

const _comment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const _inlineComment = /<!--(?:-?>|[\s\S]*?-->)/;
const _attr = / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/;
const _inlineAttr = /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/;

const _punct = /[\p{P}\p{S}]/u;
const _punctSpace = /[\s\p{P}\p{S}]/u;
const _notPunctSpace = /[^\s\p{P}\p{S}]/u;
const _punctGfm = /(?!~)[\p{P}\p{S}]/u;
const _punctSpaceGfm = /(?!~)[\s\p{P}\p{S}]/u;
const _notPunctSpaceGfm = /(?:[^\s\p{P}\p{S}]|~)/u;

// ---- other helpers (regexes) ----
const codeRemoveIndent = /^(?: {0,3}\t| {1,4})/gm;
const outputLinkReplace = /\\([\[\]])/g;
const indentCodeCompensationRe = /^(\s+)(?:```)/;
const beginningSpace = /^\s+/;
const endingHash = /#$/;
const startingSpaceChar = /^ /;
const endingSpaceChar = / $/;
const endingSpaceTabChar = /[ \t]$/;
const nonSpaceChar = /[^ ]/;
const newLineCharGlobal = /\n/g;
const tabCharGlobal = /\t/g;
const leadingSpaceTab = /^[ \t]+/;
const multipleSpaceGlobal = /\s+/g;
const blankLine = /^[ \t]*$/;
const doubleBlankLine = /\n[ \t]*\n[ \t]*$/;
const blockquoteStart = /^ {0,3}>/;
const blockquoteSetextReplace = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const blockquoteSetextReplace2 = /^ {0,3}>[ \t]?/gm;
const blockquoteMarkerWhitespace = /^( {0,3}>)([ \t]+)/gm;
const listIsTask = /^\[[ xX]\][ \t]+\S/;
const listReplaceTask = /^\[[ xX]\][ \t]+/;
const listTaskCheckbox = /\[[ xX]\]/;
const anyLine = /\n.*\n/;
const hrefBrackets = /^<(.*)>$/;
const tableDelimiter = /[:|]/;
const tableAlignChars = /^\||\| *$/g;
const tableRowBlankLine = /\n[ \t]*$/;
const tableAlignRight = /^ *-+: *$/;
const tableAlignCenter = /^ *:-+: *$/;
const tableAlignLeft = /^ *:-+ *$/;
const startATag = /^<a /i;
const endATag = /^<\/a>/i;
const startPreScriptTag = /^<(pre|code|kbd|script)(\s|>)/i;
const endPreScriptTag = /^<\/(pre|code|kbd|script)(\s|>)/i;
const startAngleBracket = /^</;
const endAngleBracket = />$/;
const unicodeAlphaNumeric = /[\p{L}\p{N}]/u;
const numericCharacterReference = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const numericCharacterReferenceOrAmpersand = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const escapeTest = /[&<>"']/;
const escapeReplace = /[&<>"']/g;
const escapeTestNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const escapeReplaceNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const percentDecode = /%25/g;
const findPipe = /\|/g;
const splitPipe = / \|/;
const slashPipe = /\\\|/g;
const carriageReturn = /\r\n|\r/g;
const notSpaceStart = /^\S*/;
const endingNewline = /\n$/;

// ---- block grammar ----
const newlineRe = /^(?:[ \t]*(?:\n|$))+/;
const blockCodeRe = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const fencesRe = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const hrRe = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const headingRe = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const bulletRe = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const bulletSrc = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
const blockCodeSrc = '(?: {4}| {0,3}\\t)';
const fencesSrc = ' {0,3}(?:`{3,}|~{3,})';
const blockquoteSrc = ' {0,3}>';
const headingSrc = ' {0,3}#{1,6}(?:\\s|$)';
const hrSrc = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const htmlLineSrc = ' {0,3}<[^\\n>]+>\\n';
const tableLineSrc = ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n';

const setextUnderlineTest = /\n {0,3}[=-]/;

const lheadingRe = new RegExp(
  '^(?!' + bulletSrc + ' |' + blockCodeSrc + '|' + fencesSrc + '|' + blockquoteSrc + '|' + headingSrc + '|' + htmlLineSrc + '|' + tableLineSrc + ')'
  + '((?:.|\\n(?!\\s*?\\n|' + bulletSrc + ' |' + fencesSrc + '|' + blockquoteSrc + '|' + headingSrc + '|' + hrSrc + '|' + htmlLineSrc + '|' + tableLineSrc + '))+?)'
  + '\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)');

const _paragraphSrc = '^([^\\n]+(?:\\n(?!hr|heading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)';
const paragraphRe = new RegExp(_paragraphSrc
  .replace('hr', hrSrc)
  .replace('heading', headingSrc)
  .replace('table', ' *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|' + hrSrc + '|' + headingSrc + '|' + blockquoteSrc + '|(?: {4}| {0,3}\\t)[^\\n]| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]| {0,3}(?:</?(?:' + _tag + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)).*(?:\\n|$))*)\\n*|$)')
  .replace('blockquote', blockquoteSrc)
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', ' {0,3}(?:</?(?:' + _tag + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)'));

const blockquoteParagraphRe = new RegExp(_paragraphSrc
  .replace('hr', hrSrc)
  .replace('heading', headingSrc)
  .replace('|table', '')
  .replace('blockquote', blockquoteSrc)
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)')
  .replace('html', ' {0,3}(?:</?(?:' + _tag + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)'));

const blockTextRe = /^[^\n]+/;
const _blockLabelSrc = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const _defTitleSrc = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\)';
const defRe = new RegExp('^ {0,3}\\[(' + _blockLabelSrc + ')\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(' + _defTitleSrc + '))? *(?:\\n+|$)');
const listRe = new RegExp('^(' + bulletSrc + ')([ \\t][^\\n]*?)?(?:\\n|$)');

const htmlBlockRe = new RegExp(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(' + _tag + ')(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:' + _attr.source + ')*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + ')', 'i');

const gfmTableRe = new RegExp(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|' + hrSrc + '|' + headingSrc + '|' + blockquoteSrc + '|(?: {4}| {0,3}\\t)[^\\n]| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]| {0,3}(?:</?(?:' + _tag + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)).*(?:\\n|$))*)\\n*|$)');

const blockquoteRe = new RegExp('^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(' + blockquoteParagraphRe.source.replace(/^\^/, '') + ')|[^\\n]*)(?:\\n|$))+');

// ---- inline grammar ----
const escapeRe = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const inlineCodeRe = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const brRe = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const punctuationRe = /^((?![*_])[\s\p{P}\p{S}])/u;
const anyPunctuationRe = /\\([\p{P}\p{S}])/gu;
const anyPunctuationOutsideCodeRe = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const autolinkRe = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const tagRe = new RegExp(
  '^' + _inlineComment.source
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:' + _inlineAttr.source + ')*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>');

const _inlineLabelBracketsSrc = '\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]';
const _inlineLabelSrc = '(?:\\[(?:' + _inlineLabelBracketsSrc + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const _linkHrefSrc = '<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\x00-\\x1f]+|(?=\\))';
const _linkTitleSrc = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)';
const linkRe = new RegExp('^!?\\[(' + _inlineLabelSrc + ')\\]\\([ \\t\\n]*(' + _linkHrefSrc + ')(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(' + _linkTitleSrc + '))?[ \\t\\n]*\\)');
const reflinkRe = new RegExp('^!?\\[(' + _inlineLabelSrc + ')\\]\\[(' + _blockLabelSrc + ')\\]');
const nolinkRe = new RegExp('^!?\\[(' + _blockLabelSrc + ')\\](?:\\[\\])?');
const _boundedBlockLabelSrc = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
const _boundedInlineLabelSrc = '(?:[^\\[\\]\\\\`]*(?:\\[(?:' + _inlineLabelBracketsSrc + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?';
const reflinkSearchRe = new RegExp('!?\\[(' + _boundedInlineLabelSrc + ')\\]\\[(' + _boundedBlockLabelSrc + ')\\]|!?\\[(' + _boundedBlockLabelSrc + ')\\](?:\\[\\])?(?!\\()', 'g');
const _extendedEmailSrc = '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const urlRe = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const backpedalRe = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

const blockSkipRe = new RegExp(
  '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)'
  + '|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)'
  + '|<(?! )[^<>]*?>', 'g');

const emStrongLDelimRe = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;

// Right-delimiter patterns. Each alternative's capture group number is the
// one marked's tokenizer reads (groups 1..6). Classes:
//   P  = GFM punctuation (punctuation except '~')
//   PS = GFM punctuation-or-space
//   NP = GFM not-punctuation-or-space
//   P2/PS2/NP2 = the same classes without the GFM '~' exception.
const _P = '(?!~)[\\p{P}\\p{S}]';
const _PS = '(?!~)[\\s\\p{P}\\p{S}]';
const _NP = '(?:[^\\s\\p{P}\\p{S}]|~)';
const _P2 = '[\\p{P}\\p{S}]';
const _PS2 = '[\\s\\p{P}\\p{S}]';
const _NP2 = '[^\\s\\p{P}\\p{S}]';
const emStrongRDelimAstRe = new RegExp(
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)' + _P + '(\\*+)(?=[\\s]|$)'
  + '|' + _NP + '(\\*+)(?!\\*)(?=' + _PS + '|$)'
  + '|(?!\\*)' + _PS + '(\\*+)(?=' + _NP + ')'
  + '|[\\s](\\*+)(?!\\*)(?=' + _P + ')'
  + '|(?!\\*)' + _P + '(\\*+)(?!\\*)(?=' + _P + ')'
  + '|' + _NP + '(\\*+)(?=' + _NP + ')', 'gu');
const emStrongRDelimUndRe = new RegExp(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)' + _P2 + '(_+)(?=[\\s]|$)'
  + '|' + _NP2 + '(_+)(?!_)(?=' + _PS2 + '|$)'
  + '|(?!_)' + _PS2 + '(_+)(?=' + _NP2 + ')'
  + '|[\\s](_+)(?!_)(?=' + _P2 + ')'
  + '|(?!_)' + _P2 + '(_+)(?!_)(?=' + _P2 + ')', 'gu');
const delLDelimRe = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const delRDelimRe = new RegExp(
  '^[^~]+(?=[^~])'
  + '|(?!~)' + _P2 + '(~~?)(?=[\\s]|$)'
  + '|' + _NP2 + '(~~?)(?!~)(?=' + _PS2 + '|$)'
  + '|(?!~)' + _PS2 + '(~~?)(?=' + _NP2 + ')'
  + '|[\\s](~~?)(?!~)(?=' + _P2 + ')'
  + '|(?!~)' + _P2 + '(~~?)(?!~)(?=' + _P2 + ')'
  + '|' + _NP2 + '(~~?)(?=' + _NP2 + ')', 'gu');

const inlineTextRe = new RegExp(
  '^(?:[^a-zA-Z0-9](?=mailto:|xmpp:)'
  + '|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)|(?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-]+@)'
  + '|[\\s\\S]*?(?:(?=[\\\\<!\\[`*_~]|\\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\\/\\/|(?<![^\\s*_~(])www\\.|$)'
  + '|[^ ](?= {2,}\\n)'
  + '|[^a-zA-Z0-9](?=mailto:|xmpp:)'
  + '|[^a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-]+@))))');

// ---- small helpers ----
const escapeReplacements = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const getEscapeReplacement = (ch) => escapeReplacements[ch];

function escapeHtmlEntities(html, encode) {
  if (encode) {
    if (escapeTest.test(html)) return html.replace(escapeReplace, getEscapeReplacement);
  } else if (escapeTestNoEncode.test(html)) {
    return html.replace(escapeReplaceNoEncode, getEscapeReplacement);
  }
  return html;
}

function decodeNumericCharacterReferences(text) {
  if (!numericCharacterReference.test(text)) return text;
  return text.replace(numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

function splitCells(tableRow, count) {
  const row = tableRow.replace(findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(splitPipe);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(slashPipe, '|');
  return cells;
}

function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) suffLen++;
    else if (currChar !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

function normalizeLabel(label) {
  return label.trim().replace(multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

function indentCodeCompensation(raw, text) {
  const matchIndentToCode = raw.match(indentCodeCompensationRe);
  if (matchIndentToCode === null) return text;
  const indentToCode = matchIndentToCode[1];
  return text.split('\n').map((node) => {
    const matchIndentInNode = node.match(beginningSpace);
    if (matchIndentInNode === null) return node;
    const indentInNode = matchIndentInNode[0];
    return node.slice(Math.min(indentInNode.length, indentToCode.length));
  }).join('\n');
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = inlineCodeRe.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = tagRe.exec(tokenSrc) || autolinkRe.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// Cached per-indent regexes used by the list tokenizer.
// Indent-bounded block-start patterns, precomputed for the four possible
// indent levels (0-3). A plain static table, not a cache of anything
// derived from input.
const _indentRes = {};
for (const n of [0, 1, 2, 3]) {
  _indentRes['nextBullet:' + n] = new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`);
  _indentRes['hr:' + n] = new RegExp(`^ {0,${n}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`);
  _indentRes['fences:' + n] = new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`);
  _indentRes['heading:' + n] = new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`);
  _indentRes['html:' + n] = new RegExp(`^ {0,${n}}(?:</?(?:${_tag})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
  _indentRes['blockquote:' + n] = new RegExp(`^ {0,${n}}>`);
}
function indentRegex(kind, indent) {
  return _indentRes[kind + ':' + Math.max(0, Math.min(3, indent - 1))];
}

function listItemRegex(bull) {
  return new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`);
}

// ---- parsing context ----
// links: normalized label -> {href, title}
// state: inLink / inRawBlock persist across inline runs (inRawBlock is
// reset before each run); linkEmitted tracks a link made inside the
// current label; linkParenPossible is the per-run ')' optimisation.
function newCtx() {
  return {
    links: Object.create(null),
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    // Mutable "top level" flag, mirroring marked's lexer.state.top: a
    // blockTokens run sets it true when it returns, a list item sets it
    // false before lexing, a blockquote saves it, sets it true, and
    // restores it. A nested list inside an item therefore leaves it true
    // for the rest of that item, so a later paragraph is lexed with the
    // greedy (multi-line) paragraph rule instead of the one-line text rule.
    top: true,
  };
}

// ---- block scanning ----
// Records are small plain objects. `src` on a paragraph/text/heading
// record is its inline source; `raw` is the source it consumed (used
// for blockquote/list accounting and for the space-merge rule).
function scanBlocks(src, ctx, out, lastParagraphClipped) {
  let clipped = lastParagraphClipped;
  let guard = Infinity;
  while (src) {
    if (src.length >= guard) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    guard = src.length;
    let rec = null;
    let len = 0;

    // space (blank lines)
    let cap = newlineRe.exec(src);
    if (cap && cap[0].length > 0) {
      const raw = cap[0];
      const last = out.at(-1);
      if (raw.length === 1 && last !== undefined) last.raw += '\n';
      else out.push({ t: 'space', raw });
      src = src.substring(raw.length);
      continue;
    }

    // indented code
    cap = blockCodeRe.exec(src);
    if (cap) {
      const raw = trimTrailingBlankLines(cap[0]);
      const text = raw.replace(codeRemoveIndent, '');
      const last = out.at(-1);
      if (last && (last.t === 'para' || last.t === 'text')) {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw;
        last.src += '\n' + text;
      } else {
        out.push({ t: 'code', text, lang: undefined, raw });
      }
      src = src.substring(raw.length);
      continue;
    }

    // fences
    cap = fencesRe.exec(src);
    if (cap) {
      const raw = cap[0];
      const lang = cap[2] ? cap[2].trim().replace(anyPunctuationRe, '$1') : cap[2];
      const text = indentCodeCompensation(raw, cap[3] || '');
      out.push({ t: 'code', text, lang, raw });
      src = src.substring(raw.length);
      continue;
    }

    // heading
    cap = headingRe.exec(src);
    if (cap) {
      let text = cap[2].trim();
      if (endingHash.test(text)) {
        const trimmed = rtrim(text, '#');
        if (!trimmed || endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
      }
      const raw = rtrim(cap[0], '\n');
      out.push({ t: 'heading', depth: cap[1].length, src: text, raw });
      src = src.substring(raw.length);
      continue;
    }

    // hr
    cap = hrRe.exec(src);
    if (cap) {
      const raw = rtrim(cap[0], '\n');
      out.push({ t: 'hr', raw });
      src = src.substring(raw.length);
      continue;
    }

    // blockquote
    rec = blockquote(src, ctx);
    if (rec) {
      out.push(rec.rec);
      src = src.substring(rec.len);
      continue;
    }

    // list
    rec = list(src, ctx);
    if (rec) {
      out.push(rec.rec);
      src = src.substring(rec.len);
      continue;
    }

    // html block
    cap = htmlBlockRe.exec(src);
    if (cap) {
      const raw = trimTrailingBlankLines(cap[0]);
      out.push({ t: 'html', text: raw, raw });
      src = src.substring(raw.length);
      continue;
    }

    // link reference definition
    cap = defRe.exec(src);
    if (cap) {
      if (startAngleBracket.test(cap[2]) || findClosingBracket(cap[2], '()') === -1) {
        const tag = normalizeLabel(cap[1]);
        const href = cap[2] ? cap[2].replace(hrefBrackets, '$1').replace(anyPunctuationRe, '$1') : '';
        const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(anyPunctuationRe, '$1') : cap[3];
        const raw = rtrim(cap[0], '\n');
        const last = out.at(-1);
        if (last && (last.t === 'para' || last.t === 'text')) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw;
          last.src += '\n' + raw;
        } else {
          if (!ctx.links[tag]) ctx.links[tag] = { href, title };
          out.push({ t: 'def', raw });
        }
        src = src.substring(raw.length);
        continue;
      }
    }

    // table (gfm) — only a header line holding a pipe, followed by a
    // delimiter line holding a dash, can start one; skip the big regex
    // otherwise.
    if (src.includes('|')) {
      const nl = src.indexOf('\n');
      if (nl !== -1) {
        const line2 = src.slice(nl + 1, src.indexOf('\n', nl + 1) === -1 ? undefined : src.indexOf('\n', nl + 1));
        if (line2.includes('-') && line2.includes('|')) {
          cap = gfmTableRe.exec(src);
          if (cap && tableDelimiter.test(cap[2])) {
      const headers = splitCells(cap[1]);
      const aligns = cap[2].replace(tableAlignChars, '').split('|');
      const rows = cap[3] && cap[3].trim() ? cap[3].replace(tableRowBlankLine, '').split('\n') : [];
      if (headers.length === aligns.length) {
        const align = [];
        for (const a of aligns) {
          if (tableAlignRight.test(a)) align.push('right');
          else if (tableAlignCenter.test(a)) align.push('center');
          else if (tableAlignLeft.test(a)) align.push('left');
          else align.push(null);
        }
        const header = [];
        for (let i = 0; i < headers.length; i++) header.push({ src: headers[i], align: align[i] });
        const rowCells = [];
        for (const row of rows) {
          rowCells.push(splitCells(row, headers.length).map((cell, i) => ({ src: cell, align: align[i] })));
        }
        const raw = rtrim(cap[0], '\n');
        out.push({ t: 'table', header, rows: rowCells, raw });
        src = src.substring(raw.length);
        continue;
      }
          }
        }
      }
    }

    // setext heading — only a line starting with '=' or '-' (after up to
    // 3 spaces) following a newline can be an underline; skip the big
    // regex otherwise.
    if (setextUnderlineTest.test(src)) {
      cap = lheadingRe.exec(src);
      if (cap) {
        const text = cap[1].trim();
        const raw = rtrim(cap[0], '\n');
        out.push({ t: 'heading', depth: cap[2].charAt(0) === '=' ? 1 : 2, src: text, raw });
        src = src.substring(raw.length);
        continue;
      }
    }

    // paragraph (top level only)
    if (ctx.top) {
      cap = paragraphRe.exec(src);
      if (cap) {
        const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
        const raw = cap[0];
        const last = out.at(-1);
        if (clipped && last && last.t === 'para') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw;
          last.src += '\n' + text;
        } else {
          out.push({ t: 'para', src: text, raw });
        }
        clipped = false;
        src = src.substring(raw.length);
        continue;
      }
    }

    // text (one line; merges with a preceding text record)
    cap = blockTextRe.exec(src);
    if (cap) {
      const raw = cap[0];
      const last = out.at(-1);
      if (last && last.t === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + raw;
        last.src += '\n' + raw;
      } else {
        out.push({ t: 'text', src: raw, raw });
      }
      src = src.substring(raw.length);
      continue;
    }

    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  ctx.top = true;
  return out;
}

// ---- blockquote ----
function blockquote(src, ctx) {
  const cap = blockquoteRe.exec(src);
  if (!cap) return null;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const inner = [];
  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (blockquoteStart.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);
    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      .replace(blockquoteMarkerWhitespace, (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length))
      .replace(blockquoteSetextReplace, '\n    $1')
      .replace(blockquoteSetextReplace2, '');
    raw = raw ? raw + '\n' + currentRaw : currentRaw;
    text = text ? text + '\n' + currentText : currentText;
    // parse blockquote lines as top level tokens
    const savedTop = ctx.top;
    ctx.top = true;
    scanBlocks(currentText, ctx, inner, true);
    ctx.top = savedTop;
    if (lines.length === 0) break;
    const lastToken = inner.at(-1);
    if (lastToken && (lastToken.t === 'code' || lastToken.t === 'heading' || lastToken.t === 'hr' || lastToken.t === 'html' || lastToken.t === 'table')) {
      break;
    } else if (lastToken && lastToken.t === 'blockquote') {
      const oldToken = lastToken;
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(blockquoteSetextReplace2, '');
      const newToken = blockquote(newText, ctx);
      inner[inner.length - 1] = newToken.rec;
      const leftover = newText.substring(newToken.rec.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
      text = text.substring(0, text.length - oldToken.text.length) + newToken.rec.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && blockquoteStart.test(lines[0])) continue;
      break;
    } else if (lastToken && lastToken.t === 'list') {
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = list(newText, ctx);
      inner[inner.length - 1] = newToken.rec;
      const consumedCount = newToken.rec.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newToken.rec.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = raw + '\n' + consumed;
        text = text + '\n' + consumed;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }
  return { rec: { t: 'blockquote', inner, raw, text }, len: raw.length };
}

// ---- list ----
function list(src, ctx) {
  let cap = listRe.exec(src);
  if (!cap) return null;
  const listSrc = src;
  let rest = src;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;
  const listRec = {
    t: 'list',
    ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
    raw: '',
  };
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = listItemRegex(bull);
  let endsWithBlankLine = false;
  while (rest) {
    let endEarly = false;
    let itemContents = '';
    if (!(cap = itemRegex.exec(rest))) break;
    if (hrRe.test(rest)) break;
    const itemStart = listSrc.length - rest.length;
    rest = rest.substring(cap[0].length);
    const firstLine = cap[2].split('\n', 1)[0];
    const bulletIndent = cap[1].length;
    let line = firstLine.replace(leadingSpaceTab, (whitespace) => expandTabs(whitespace, bulletIndent));
    const nextLine = rest.split('\n', 1)[0];
    let blankLineFlag = !line.trim();
    let indent = 0;
    if (blankLineFlag) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(nonSpaceChar);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }
    if (blankLineFlag && blankLine.test(nextLine)) {
      rest = rest.substring(nextLine.length + 1);
      endEarly = true;
    }
    if (!endEarly) {
      const nextBulletRegex = indentRegex('nextBullet', indent);
      const hrRegex = indentRegex('hr', indent);
      const fencesBeginRegex = indentRegex('fences', indent);
      const headingBeginRegex = indentRegex('heading', indent);
      const htmlBeginRegex = indentRegex('html', indent);
      const blockquoteBeginRegex = indentRegex('blockquote', indent);
      while (rest) {
        const rawLine = rest.split('\n', 1)[0];
        const nextLine2 = rawLine;
        const nextLineWithoutTabs = nextLine2.replace(leadingSpaceTab, (whitespace) => expandTabs(whitespace));
        if (fencesBeginRegex.test(nextLine2)) break;
        if (headingBeginRegex.test(nextLine2)) break;
        if (htmlBeginRegex.test(nextLine2)) break;
        if (blockquoteBeginRegex.test(nextLine2)) break;
        if (nextBulletRegex.test(nextLine2)) break;
        if (hrRegex.test(nextLine2)) break;
        if (nextLineWithoutTabs.search(nonSpaceChar) >= indent || !nextLine2.trim()) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (blankLineFlag) break;
          if (line.replace(tabCharGlobal, '    ').search(nonSpaceChar) >= 4) break;
          if (fencesBeginRegex.test(line)) break;
          if (headingBeginRegex.test(line)) break;
          if (htmlBeginRegex.test(line)) break;
          if (hrRegex.test(line)) break;
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine2)
            && lheadingRe.test(line + '\n' + nextLine2);
          const continuation = setextContinuation
            ? '    ' + nextLineWithoutTabs.replace(/^ {0,3}/, '')
            : nextLine2;
          itemContents += '\n' + continuation;
        }
        blankLineFlag = !nextLine2.trim();
        rest = rest.substring(rawLine.length + 1);
        line = nextLineWithoutTabs.slice(indent);
      }
    }
    const raw = listSrc.slice(itemStart, listSrc.length - rest.length);
    if (!listRec.loose) {
      if (endsWithBlankLine) listRec.loose = true;
      else if (doubleBlankLine.test(raw)) endsWithBlankLine = true;
    }
    listRec.items.push({
      task: listIsTask.test(itemContents),
      loose: false,
      text: itemContents,
      records: [],
      raw,
    });
  }
  const lastItem = listRec.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return null;
  }
  listRec.raw = listSrc.slice(0, listSrc.length - rest.length).trimEnd();

  for (const item of listRec.items) {
    ctx.top = false;
    scanBlocks(item.text, ctx, item.records, false);
    if (!listRec.loose) {
      const spacers = item.records.filter((t) => t.t === 'space');
      const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => anyLine.test(t.raw));
      listRec.loose = hasMultipleLineBreaks;
    }
  }

  for (const item of listRec.items) {
    const itemToken = item.records[0];
    if (item.task && itemToken && (itemToken.t === 'text' || itemToken.t === 'para')) {
      item.text = item.text.replace(listReplaceTask, '');
      itemToken.raw = itemToken.raw.replace(listReplaceTask, '');
      itemToken.src = itemToken.src.replace(listReplaceTask, '');
      const taskRaw = listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const checked = taskRaw[0] !== '[ ]';
        item.checked = checked;
        const checkboxHtml = '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        if (listRec.loose) {
          if (item.records[0] && (item.records[0].t === 'para' || item.records[0].t === 'text')) {
            item.records[0].prefix = checkboxHtml;
          } else {
            item.records.unshift({ t: 'para', src: '', prefix: checkboxHtml, raw: taskRaw[0] + ' ' });
          }
        } else {
          item.records.unshift({ t: 'checkbox', checked });
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }

  if (listRec.loose) {
    for (const item of listRec.items) {
      item.loose = true;
      for (const token of item.records) {
        if (token.t === 'text') token.t = 'para';
      }
    }
  }

  return { rec: listRec, len: listRec.raw.length };
}

// ---- rendering ----
function renderBlocks(recs, ctx, out) {
  for (const rec of recs) {
    switch (rec.t) {
      case 'space':
        break;
      case 'code': {
        const langString = (rec.lang || '').match(notSpaceStart)?.[0];
        const code = rec.text ? rec.text.replace(endingNewline, '') + '\n' : '';
        if (!langString) {
          out.push('<pre><code>' + escapeHtmlEntities(code, true) + '</code></pre>\n');
        } else {
          out.push('<pre><code class="language-' + escapeHtmlEntities(langString) + '">' + escapeHtmlEntities(code, true) + '</code></pre>\n');
        }
        break;
      }
      case 'heading':
        out.push('<h' + rec.depth + '>' + inlineRun(rec.src, ctx) + '</h' + rec.depth + '>\n');
        break;
      case 'hr':
        out.push('<hr>\n');
        break;
      case 'blockquote': {
        const inner = [];
        renderBlocks(rec.inner, ctx, inner);
        out.push('<blockquote>\n' + inner.join('') + '</blockquote>\n');
        break;
      }
      case 'list': {
        const body = [];
        for (const item of rec.items) {
          const itemOut = [];
          renderBlocks(item.records, ctx, itemOut);
          body.push('<li>' + itemOut.join('') + '</li>\n');
        }
        const type = rec.ordered ? 'ol' : 'ul';
        const startAttr = (rec.ordered && rec.start !== 1) ? ' start="' + rec.start + '"' : '';
        out.push('<' + type + startAttr + '>\n' + body.join('') + '</' + type + '>\n');
        break;
      }
      case 'checkbox':
        out.push('<input ' + (rec.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ');
        break;
      case 'html':
        out.push(rec.text);
        break;
      case 'def':
        break;
      case 'para':
        out.push('<p>' + (rec.prefix || '') + inlineRun(rec.src, ctx) + '</p>\n');
        break;
      case 'text':
        out.push((rec.prefix || '') + inlineRun(rec.src, ctx));
        break;
      case 'table': {
        let header = '';
        for (let j = 0; j < rec.header.length; j++) {
          const cell = rec.header[j];
          const tag = cell.align ? '<th align="' + cell.align + '">' : '<th>';
          header += tag + inlineRun(cell.src, ctx) + '</th>\n';
        }
        header = '<tr>\n' + header + '</tr>\n';
        let body = '';
        for (const row of rec.rows) {
          let cellHtml = '';
          for (const cell of row) {
            const tag = cell.align ? '<td align="' + cell.align + '">' : '<td>';
            cellHtml += tag + inlineRun(cell.src, ctx) + '</td>\n';
          }
          body += '<tr>\n' + cellHtml + '</tr>\n';
        }
        if (body) body = '<tbody>' + body + '</tbody>';
        out.push('<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n');
        break;
      }
    }
  }
}

function inlineRun(src, ctx) {
  ctx.inRawBlock = false;
  return inline(src, ctx, 'html');
}

// ---- inline masking (for emphasis / strikethrough) ----
// Links, code spans, HTML and escapes are hidden from the delimiter
// scanners by replacing them with same-length runs, so a `*` inside a
// link text or a code span cannot open or close emphasis.
const reflinkSearchSrc = '!?\\[(' + _boundedInlineLabelSrc + ')\\]\\[(' + _boundedBlockLabelSrc + ')\\]|!?\\[(' + _boundedBlockLabelSrc + ')\\](?:\\[\\])?(?!\\()';
const blockSkipSrc = '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)|<(?! )[^<>]*?>';

function linkInText(text, ctx) {
  if (!text.includes('[')) return false;
  const blockSkip = new RegExp(blockSkipSrc, 'g');
  for (const match of text.matchAll(blockSkip)) {
    if (linkRe.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  const reflinkSearch = new RegExp(reflinkSearchSrc, 'g');
  for (const match of text.matchAll(reflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(ctx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1), ctx)) continue;
    return true;
  }
  return false;
}

function maskSrc(src, ctx) {
  let maskedSrc = src;
  if (ctx.links && src.includes('[')) {
    const reflinkSearch = new RegExp(reflinkSearchSrc, 'g');
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(ctx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(text, ctx)) {
          return '[' + text.replace(new RegExp(reflinkSearchSrc, 'g'), maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(reflinkSearch, maskReflink);
  }
  // Mask backslash-escapes and code spans so emphasis delimiters inside
  // them are not seen; only needed when the text holds a backslash or a
  // backtick.
  if (src.includes('\\') || src.includes('`')) {
    maskedSrc = maskedSrc.replace(anyPunctuationOutsideCodeRe, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }
  // Mask links, code spans and html tags; only needed when the text holds
  // a bracket, a backtick or a '<'.
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    maskedSrc = maskedSrc.replace(new RegExp(blockSkipSrc, 'g'), (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }
  return maskedSrc;
}

// One scan of the masked source for the last runs that can close
// emphasis, strong emphasis and strikethrough.
function scanClosers(src) {
  const last = { '*': -1, '_': -1 };
  let tilde = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') tilde = i;
      else last[ch] = i;
    }
    i = j - 1;
  }
  return { star: last['*'], under: last['_'], tilde };
}

// ---- inline tokenizers (each returns {html, len} or null) ----
function tagState(tagText, ctx) {
  if (!ctx.inLink && startATag.test(tagText)) ctx.inLink = true;
  else if (ctx.inLink && endATag.test(tagText)) ctx.inLink = false;
  if (!ctx.inRawBlock && startPreScriptTag.test(tagText)) ctx.inRawBlock = true;
  else if (ctx.inRawBlock && endPreScriptTag.test(tagText)) ctx.inRawBlock = false;
}

function outputLink(cap, link, raw, ctx, mode) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = ctx.inLink;
  const outerLinkEmitted = ctx.linkEmitted;
  const outerInRawBlock = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const inner = inline(text, ctx, isImage ? 'text' : mode);
  const textHasLink = ctx.linkEmitted;
  ctx.linkEmitted = outerLinkEmitted;
  ctx.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      ctx.inRawBlock = outerInRawBlock;
      return null;
    }
    ctx.linkEmitted = true;
    if (mode === 'text') return { html: inner, len: raw.length };
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) return { html: inner, len: raw.length };
    let out = '<a href="' + escapeHtmlEntities(cleanHref) + '"';
    if (title) out += ' title="' + escapeHtmlEntities(title) + '"';
    out += '>' + inner + '</a>';
    return { html: out, len: raw.length };
  }
  if (mode === 'text') return { html: inner, len: raw.length };
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return { html: escapeHtmlEntities(inner), len: raw.length };
  let out = '<img src="' + escapeHtmlEntities(cleanHref) + '" alt="' + escapeHtmlEntities(inner) + '"';
  if (title) out += ' title="' + escapeHtmlEntities(title) + '"';
  out += '>';
  return { html: out, len: raw.length };
}

function tryLink(src, ctx, mode) {
  if (ctx.linkParenPossible === false) return null;
  const cap = linkRe.exec(src);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart)) return null;
  const trimmedUrl = cap[2].trim();
  if (startAngleBracket.test(trimmedUrl)) {
    if (!endAngleBracket.test(trimmedUrl)) return null;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return null;
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return null;
  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (startAngleBracket.test(href)) href = href.slice(1, -1);
  return outputLink(cap, {
    href: href ? href.replace(anyPunctuationRe, '$1') : href,
    title: title ? title.replace(anyPunctuationRe, '$1') : title,
  }, cap[0], ctx, mode);
}

function tryReflink(src, ctx, mode) {
  const cap = reflinkRe.exec(src) || nolinkRe.exec(src);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart)) return null;
  const link = ctx.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    const text = cap[0].charAt(0);
    return { html: text, len: 1, isText: true, textChar: text };
  }
  return outputLink(cap, link, cap[0], ctx, mode);
}

function tryEmStrong(src, maskedSrc, prevChar, ctx, mode, hint) {
  const match = emStrongLDelimRe.exec(src);
  if (!match) return null;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return null;
  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!punctuationRe.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!punctuationRe.exec(prevChar);
  if (match[4] && prevChar.match(unicodeAlphaNumeric)) return null;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...match[0]].length - 1;
    let rDelim;
    let rLength;
    let delimTotal = lLength;
    let midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return null;
    const endReg = delimChar === '*' ? emStrongRDelimAstRe : emStrongRDelimUndRe;
    const lastIdx = delimChar === '*' ? hint.star : hint.under;
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastIdx < windowStart) return null;
    const windowSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastInWindow = lastIdx - windowStart;
    endReg.lastIndex = 0;
    let m;
    while ((m = endReg.exec(windowSrc)) !== null) {
      if (m.index > lastInWindow) break;
      rDelim = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (m[3] || m[4]) {
        delimTotal += rLength;
        continue;
      } else if (m[5] || m[6] || openerCanClose) {
        if (midRun && (m[5] || m[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...m[0]][0].length;
      const raw = src.slice(0, lLength + m.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        return {
          html: mode === 'text' ? inline(text, ctx, 'text') : '<em>' + inline(text, ctx, 'html') + '</em>',
          len: raw.length,
        };
      }
      const text = raw.slice(2, -2);
      return {
        html: mode === 'text' ? inline(text, ctx, 'text') : '<strong>' + inline(text, ctx, 'html') + '</strong>',
        len: raw.length,
      };
    }
  }
  return null;
}

function tryDel(src, maskedSrc, prevChar, ctx, mode, hint) {
  const match = delLDelimRe.exec(src);
  if (!match) return null;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || punctuationRe.exec(prevChar)) {
    const lLength = [...match[0]].length - 1;
    let rDelim;
    let rLength;
    let delimTotal = lLength;
    const lastIdx = hint.tilde;
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastIdx < windowStart) return null;
    const windowSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastInWindow = lastIdx - windowStart;
    delRDelimRe.lastIndex = 0;
    let m;
    while ((m = delRDelimRe.exec(windowSrc)) !== null) {
      if (m.index > lastInWindow) break;
      rDelim = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (m[3] || m[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...m[0]][0].length;
      const raw = src.slice(0, lLength + m.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      return {
        html: mode === 'text' ? inline(text, ctx, 'text') : '<del>' + inline(text, ctx, 'html') + '</del>',
        len: raw.length,
      };
    }
  }
  return null;
}

function tryAutolink(src, ctx, mode) {
  const cap = autolinkRe.exec(src);
  if (!cap) return null;
  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[1];
    href = 'mailto:' + text;
  } else {
    text = cap[1];
    href = text;
  }
  if (mode === 'text') return { html: text, len: cap[0].length };
  const parsedText = escapeHtmlEntities(text, true);
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return { html: parsedText, len: cap[0].length };
  return { html: '<a href="' + escapeHtmlEntities(cleanHref, true) + '">' + parsedText + '</a>', len: cap[0].length };
}

function tryUrl(src, ctx, mode) {
  const cap = urlRe.exec(src);
  if (!cap) return null;
  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prevCapZero;
    do {
      prevCapZero = cap[0];
      cap[0] = backpedalRe.exec(cap[0])?.[0] ?? '';
    } while (prevCapZero !== cap[0]);
    text = cap[0];
    if (cap[1] === 'www.') href = 'http://' + cap[0];
    else href = cap[0];
  }
  if (mode === 'text') return { html: text, len: cap[0].length };
  const parsedText = escapeHtmlEntities(text, true);
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return { html: parsedText, len: cap[0].length };
  return { html: '<a href="' + escapeHtmlEntities(cleanHref, true) + '">' + parsedText + '</a>', len: cap[0].length };
}

// Cheap pre-check: could a GFM extended autolink start here? A superset
// of the url grammar, so a "no" is exact and a "yes" is verified by the
// regex itself.
function urlMaybe(s) {
  const c0 = s.charCodeAt(0);
  if (c0 === 119) {
    if (s.startsWith('www.')) return true;
  } else if (c0 === 104 || c0 === 72) {
    const p = s.slice(0, 8).toLowerCase();
    if (p.startsWith('http://') || p.startsWith('https://')) return true;
  } else if (c0 === 102 || c0 === 70) {
    if (s.slice(0, 6).toLowerCase() === 'ftp://') return true;
  } else if (c0 === 109) {
    if (s.startsWith('mailto:')) return true;
  } else if (c0 === 120) {
    if (s.startsWith('xmpp:')) return true;
  }
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  if (i > 0 && i < n && s.charCodeAt(i) === 64) {
    let j = i + 1;
    let dot = false;
    while (j < n) {
      const c = s.charCodeAt(j);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95) j++;
      else if (c === 46) { dot = true; j++; }
      else break;
    }
    if (dot) return true;
  }
  return false;
}

// ---- the inline loop ----
// mode 'html' renders markup; mode 'text' flattens it (image alt text).
// Dispatch is by first character, which is exactly the set of tokenizers
// that can match there; text is the fallback everywhere.
function inline(src, ctx, mode) {
  const prevLinkParenPossible = ctx.linkParenPossible;
  ctx.linkParenPossible = prevLinkParenPossible && src.includes(')');
  try {
    return inlineInner(src, ctx, mode);
  } finally {
    ctx.linkParenPossible = prevLinkParenPossible;
  }
}

function inlineInner(src, ctx, mode) {
  let maskedSrc = src;
  let hint = { star: -1, under: -1, tilde: -1 };
  if (src.includes('*') || src.includes('_') || src.includes('~')) {
    maskedSrc = maskSrc(src, ctx);
    hint = scanClosers(maskedSrc);
  }
  const out = [];
  let keepPrevChar = false;
  let prevChar = '';
  let guard = Infinity;
  while (src) {
    if (src.length >= guard) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    guard = src.length;
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    const ch = src[0];
    let res = null;
    if (ch === '\\') {
      let cap = escapeRe.exec(src);
      if (cap) {
        // An escape token renders its character, HTML-escaped (it has no
        // `escaped` flag; only raw-block text is emitted unescaped).
        out.push(mode === 'text' ? cap[1] : escapeHtmlEntities(cap[1]));
        src = src.substring(cap[0].length);
        continue;
      }
      cap = brRe.exec(src);
      if (cap) {
        if (mode === 'html') out.push('<br>');
        src = src.substring(cap[0].length);
        continue;
      }
    } else if (ch === '<') {
      let cap = tagRe.exec(src);
      if (cap) {
        tagState(cap[0], ctx);
        out.push(cap[0]);
        src = src.substring(cap[0].length);
        continue;
      }
      res = tryAutolink(src, ctx, mode);
      if (res) {
        out.push(res.html);
        src = src.substring(res.len);
        continue;
      }
    } else if (ch === '[' || ch === '!') {
      res = tryLink(src, ctx, mode);
      if (res) {
        out.push(res.html);
        src = src.substring(res.len);
        continue;
      }
      res = tryReflink(src, ctx, mode);
      if (res) {
        out.push(res.html);
        if (res.isText) {
          if (res.textChar !== '_') prevChar = res.textChar;
          keepPrevChar = true;
        }
        src = src.substring(res.len);
        continue;
      }
    } else if (ch === '*' || ch === '_') {
      res = tryEmStrong(src, maskedSrc, prevChar, ctx, mode, hint);
      if (res) {
        out.push(res.html);
        src = src.substring(res.len);
        continue;
      }
    } else if (ch === '`') {
      const cap = inlineCodeRe.exec(src);
      if (cap) {
        let text = cap[2].replace(newLineCharGlobal, ' ');
        const hasNonSpaceChars = nonSpaceChar.test(text);
        const hasSpaceCharsOnBothEnds = startingSpaceChar.test(text) && endingSpaceChar.test(text);
        if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) text = text.substring(1, text.length - 1);
        if (mode === 'text') out.push(text);
        else out.push('<code>' + escapeHtmlEntities(text, true) + '</code>');
        src = src.substring(cap[0].length);
        continue;
      }
    } else if (ch === ' ') {
      const cap = brRe.exec(src);
      if (cap) {
        if (mode === 'html') out.push('<br>');
        src = src.substring(cap[0].length);
        continue;
      }
    } else if (ch === '~') {
      res = tryDel(src, maskedSrc, prevChar, ctx, mode, hint);
      if (res) {
        out.push(res.html);
        src = src.substring(res.len);
        continue;
      }
    } else if (!ctx.inLink && urlMaybe(src)) {
      res = tryUrl(src, ctx, mode);
      if (res) {
        out.push(res.html);
        src = src.substring(res.len);
        continue;
      }
    }
    // plain text run
    const cap = inlineTextRe.exec(src);
    if (cap) {
      const raw = cap[0];
      const escaped = ctx.inRawBlock;
      const text = escaped ? raw : decodeNumericCharacterReferences(raw);
      if (mode === 'text') out.push(text);
      else out.push(escaped ? text : escapeHtmlEntities(text));
      if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
      keepPrevChar = true;
      src = src.substring(raw.length);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  return out.join('');
}

// ---- entry point ----
export function parse(markdown) {
  const src = String(markdown).replace(carriageReturn, '\n');
  const ctx = newCtx();
  const recs = [];
  scanBlocks(src, ctx, recs, false);
  const out = [];
  renderBlocks(recs, ctx, out);
  return out.join('');
}
