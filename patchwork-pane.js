// any patchwork doc at all (a tldraw you're working from, notes, …), shown
// with the patchwork tool the pane asks for (`context.toolId`), or else
// whichever one patchwork picks for it. no repo-provider of its own: there
// should only be the one, or history goes missing
export default function PatchworkPane(handle, element, context) {
  const view = document.createElement("patchwork-view");
  view.setAttribute("doc-url", handle.url);
  if (context?.toolId) view.setAttribute("tool-id", context.toolId);
  view.style.cssText = "display: flex; flex: 1; min-width: 0; min-height: 0; overflow: auto;";

  element.appendChild(view);
  return () => view.remove();
}
