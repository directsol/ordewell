/** The conversation line for a task starting, worded the same on every surface. */
export function taskStartedNotice(title: string, runner?: string): string {
  return runner ? `Started "${title}" · ${runner}` : `Started "${title}"`;
}
