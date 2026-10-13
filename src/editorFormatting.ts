/** Toggle Markdown emphasis while keeping the selection inside its markers. */
export function toggleEmphasis(input: HTMLTextAreaElement, marker: string) {
  const { value } = input;
  let start = input.selectionStart, end = input.selectionEnd;
  if (start === end) {
    const word = /[\p{L}\p{N}\p{M}_]/u;
    // Expand an empty selection to the word touching the caret.
    while (start > 0 && word.test(value[start - 1])) start--;
    while (end < value.length && word.test(value[end])) end++;
  }
  const size = marker.length, selected = value.slice(start, end);
  let from = start, to = end, replacement = marker + selected + marker, offset = size;
  if (start >= size && value.slice(start - size, start) === marker && value.slice(end, end + size) === marker) {
    from -= size; to += size; replacement = selected; offset = 0;
  } else if (selected.length >= 2 * size && selected.startsWith(marker) && selected.endsWith(marker)) {
    replacement = selected.slice(size, -size); offset = 0;
  }
  input.setRangeText(replacement, from, to, 'end');
  input.setSelectionRange(from + offset, from + replacement.length - offset);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
