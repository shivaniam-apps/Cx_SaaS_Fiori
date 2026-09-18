// Static accessibility audit of JSX sources (roadmap A13).
//
// UI5 Web Components render their own ARIA, but only when the page gives
// them a name: an icon-only Button without accessibleName is announced as
// "button", an Input without a linked Label or accessibleName as "edit
// text", a Table without accessibleName as "table". This module scans the
// JSX text for such controls so the gap is a failing test, not a manual
// review. It is deliberately a text scanner, not a parser: pages are plain
// JSX with string attributes, and the rules only need the attribute list
// and whether an element has text content.

const NAMED_CONTROLS = new Set([
  'Input', 'TextArea', 'SearchField', 'DatePicker', 'DateRangePicker', 'TimePicker',
  'Select', 'ComboBox', 'MultiComboBox', 'MultiInput', 'StepInput', 'Slider', 'RangeSlider'
]);
const TOGGLE_CONTROLS = new Set(['CheckBox', 'Switch', 'RadioButton', 'SegmentedButton']);
const NATIVE_FIELDS = new Set(['input', 'select', 'textarea']);
const ALL_TAGS = new Set([
  ...NAMED_CONTROLS, ...TOGGLE_CONTROLS, ...NATIVE_FIELDS,
  'Button', 'ToggleButton', 'Icon', 'Table', 'Dialog', 'Popover', 'button', 'Label'
]);

// Walks from the character after "<Tag" to the closing ">" of the opening
// tag, skipping over quoted strings and {...} expressions (which may contain
// ">" inside arrow functions). Returns { attributes, selfClosing, end }.
function readOpeningTag(source, from) {
  let depth = 0;
  let quote = null;
  let i = from;
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
    } else if (ch === '>' && depth === 0) {
      const selfClosing = source[i - 1] === '/';
      const attributes = source.slice(from, selfClosing ? i - 1 : i);
      return { attributes, selfClosing, end: i + 1 };
    }
    i += 1;
  }
  return { attributes: source.slice(from), selfClosing: true, end: source.length };
}

function hasAttribute(attributes, name) {
  return new RegExp(`(^|[\\s{])${name}\\s*=`).test(attributes);
}

function stringAttribute(attributes, name) {
  const match = attributes.match(new RegExp(`(^|[\\s{])${name}\\s*=\\s*["']([^"']*)["']`));
  return match ? match[2] : null;
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

// Text content between the opening tag and the matching closing tag of the
// same name (nested same-name tags are counted). Comments are dropped.
function innerContent(source, tagName, from) {
  const open = new RegExp(`<${tagName}\\b`, 'g');
  const close = new RegExp(`</${tagName}\\s*>`, 'g');
  let depth = 1;
  let cursor = from;
  for (;;) {
    open.lastIndex = cursor;
    close.lastIndex = cursor;
    const nextOpen = open.exec(source);
    const nextClose = close.exec(source);
    if (!nextClose) return source.slice(from);
    if (nextOpen && nextOpen.index < nextClose.index) {
      const tag = readOpeningTag(source, nextOpen.index + nextOpen[0].length);
      if (!tag.selfClosing) depth += 1;
      cursor = tag.end;
      continue;
    }
    depth -= 1;
    if (depth === 0) return source.slice(from, nextClose.index);
    cursor = nextClose.index + nextClose[0].length;
  }
}

function hasVisibleText(content) {
  const withoutComments = content.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  // Text nodes or expressions count as a label; nested elements alone do not
  // (an icon child does not name a button).
  const withoutElements = withoutComments.replace(/<[^>]*>/g, '');
  return /\S/.test(withoutElements);
}

function collectLabelTargets(source) {
  const targets = new Set();
  const pattern = /<Label\b/g;
  let match;
  while ((match = pattern.exec(source))) {
    const tag = readOpeningTag(source, match.index + match[0].length);
    const target = stringAttribute(tag.attributes, 'for') || stringAttribute(tag.attributes, 'htmlFor');
    if (target) targets.add(target);
    pattern.lastIndex = tag.end;
  }
  return targets;
}

function isNamed(attributes, labelTargets) {
  if (hasAttribute(attributes, 'accessibleName') || hasAttribute(attributes, 'accessibleNameRef')) return true;
  if (hasAttribute(attributes, 'aria-label') || hasAttribute(attributes, 'aria-labelledby')) return true;
  const id = stringAttribute(attributes, 'id');
  return Boolean(id && labelTargets.has(id));
}

// Returns [{ line, tag, reason }] for one source file.
export function auditSource(source, { file = '' } = {}) {
  const findings = [];
  const labelTargets = collectLabelTargets(source);
  const pattern = /<([A-Za-z][A-Za-z0-9]*)\b/g;
  let match;
  while ((match = pattern.exec(source))) {
    const tagName = match[1];
    const tag = readOpeningTag(source, match.index + match[0].length);
    pattern.lastIndex = tag.end;
    if (!ALL_TAGS.has(tagName) || tagName === 'Label') continue;
    const { attributes } = tag;
    const line = lineOf(source, match.index);
    const report = (reason) => findings.push({ file, line, tag: tagName, reason });

    if (tagName === 'Button' || tagName === 'ToggleButton' || tagName === 'button') {
      const content = tag.selfClosing ? '' : innerContent(source, tagName, tag.end);
      if (!hasVisibleText(content) && !isNamed(attributes, labelTargets)) {
        report('icon-only button needs accessibleName');
      }
    } else if (tagName === 'Icon') {
      const decorative = /mode\s*=\s*["']Decorative["']/.test(attributes) || hasAttribute(attributes, 'aria-hidden');
      if (!decorative && !isNamed(attributes, labelTargets)) {
        report('icon needs accessibleName or mode="Decorative"');
      }
    } else if (NAMED_CONTROLS.has(tagName)) {
      if (!isNamed(attributes, labelTargets)) report('field needs a linked Label (id + for), accessibleName or accessibleNameRef');
    } else if (TOGGLE_CONTROLS.has(tagName)) {
      const labelled = hasAttribute(attributes, 'text') || hasAttribute(attributes, 'textOn') || isNamed(attributes, labelTargets);
      if (!labelled) report('toggle needs text or accessibleName');
    } else if (NATIVE_FIELDS.has(tagName)) {
      const type = stringAttribute(attributes, 'type');
      if (type !== 'hidden' && !isNamed(attributes, labelTargets)) report('native field needs aria-label or a linked label');
    } else if (tagName === 'Table') {
      if (!isNamed(attributes, labelTargets)) report('table needs accessibleName');
    } else if (tagName === 'Dialog' || tagName === 'Popover') {
      if (!hasAttribute(attributes, 'headerText') && !isNamed(attributes, labelTargets)) report('dialog needs headerText or accessibleName');
    }
  }
  return findings;
}

export function formatFindings(findings) {
  return findings.map((f) => `${f.file}:${f.line} <${f.tag}> ${f.reason}`).join('\n');
}
