/**
 * Pick a product name from on-device OCR label text.
 *
 * Scans the label lines in order and returns the first one that looks
 * like real words, capped at 40 characters. The first line is often
 * the volume ("16.9 FL OZ"), which fails the check, while a real
 * brand or product line sits below it — so only testing the first
 * line left water bottles (and similar labels) with no product name.
 *
 * Only lines from the actual OCR text are ever returned; nothing is
 * invented. Returns '' when no line looks like real words.
 */
export function pickProductNameFromLabel(labelText: string): string {
  const lines = labelText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const productLine = lines.find((line) => {
    const letters = line.replace(/[^a-z]/gi, '').length;
    return (
      line.length >= 3 &&
      /[a-z]{4,}/i.test(line) &&
      letters / line.length >= 0.6
    );
  });
  return productLine ? productLine.slice(0, 40) : '';
}
