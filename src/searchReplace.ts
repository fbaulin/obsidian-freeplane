export interface SearchOptions { regex: boolean; caseSensitive: boolean; wholeWord: boolean; }
export function searchPattern(query: string, options: SearchOptions, all = false): RegExp {
  let source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (options.wholeWord) source = '(?<![\\p{L}\\p{N}_])(?:' + source + ')(?![\\p{L}\\p{N}_])';
  return new RegExp(source, 'u' + (options.caseSensitive ? '' : 'i') + (all ? 'g' : ''));
}
