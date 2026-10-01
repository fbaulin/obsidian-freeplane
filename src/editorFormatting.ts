/** Toggle Markdown emphasis while keeping the selection inside its markers. */
export function toggleEmphasis(input: HTMLTextAreaElement, marker: string) {
  const { selectionStart: start, selectionEnd: end, value } = input;
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
