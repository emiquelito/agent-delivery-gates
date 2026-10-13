// Escapes every regular-expression metacharacter in `text`, so a RegExp
// built from it matches only that exact text. The backslash is in the set:
// leaving it out is the partial escape that looks right and is not.
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
