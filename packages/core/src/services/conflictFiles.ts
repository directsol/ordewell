/**
 * Pure, no-imports helper so a browser surface can format a conflict's files
 * without pulling `isolationRecord` — and its `path` import — into a webview
 * bundle. Kept out of `isolationRecord.ts` for exactly that reason.
 */
export function capConflictFiles(files: string[], max = 5): string {
  return files.length <= max ? files.join(', ') : `${files.slice(0, max).join(', ')}, +${files.length - max} more`;
}
