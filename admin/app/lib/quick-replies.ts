/** Meta's limits for Messenger quick replies; the API enforces the same numbers. */
export const MAX_QUICK_REPLIES = 13;
export const QUICK_REPLY_TITLE_MAX = 20;

/** Parses "Xem giá, Gặp nhân viên" into button titles and lists every problem at once. */
export function parseQuickReplies(raw: string): { items: string[]; error: string } {
  const items = [...new Set(raw.split(',').map((q) => q.trim()).filter(Boolean))];
  const problems: string[] = [];
  if (items.length > MAX_QUICK_REPLIES) problems.push(`tối đa ${MAX_QUICK_REPLIES} nút, đang có ${items.length}`);
  const tooLong = items.filter((q) => q.length > QUICK_REPLY_TITLE_MAX);
  if (tooLong.length) {
    problems.push(
      `mỗi nút tối đa ${QUICK_REPLY_TITLE_MAX} ký tự, quá dài: ${tooLong.map((q) => `"${q}" (${q.length})`).join(', ')}`,
    );
  }
  return { items, error: problems.join('; ') };
}
