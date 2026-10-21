// The checkboxes' layout and their bits, shared by the functions and the page. It imports nothing of the server, so
// the page's bundle stays free of it.

export const NUM_BOXES = 1_000_000;
export const BOXES_PER_DOCUMENT = 4000;
export const NUM_DOCUMENTS = Math.floor(NUM_BOXES / BOXES_PER_DOCUMENT);

/** Whether box `arrayIdx` of a document's bytes is checked. */
export function isChecked(view: Uint8Array, arrayIdx: number): boolean {
  const byte = view ? (view[Math.floor(arrayIdx / 8)] ?? 0) : 0;
  return (byte & (1 << (arrayIdx % 8))) !== 0;
}

/** Set box `arrayIdx` to `checked` in `view`: the view, or undefined when it already was (nothing to write). */
export function shiftBit(view: Uint8Array, arrayIdx: number, checked: boolean): Uint8Array | undefined {
  if (isChecked(view, arrayIdx) === checked) return undefined;
  const at = Math.floor(arrayIdx / 8);
  view[at] = (view[at] ?? 0) ^ (1 << (arrayIdx % 8));
  return view;
}
