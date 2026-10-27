// any patchwork doc at all (a tldraw you're working from, notes, …), shown
// with whichever tool patchwork picks for it
export default function PatchworkPane(handle, element, context) {
  const provider = document.createElement("repo-provider");
  provider.repo = context.repo;
  provider.style.display = "contents";

  const view = document.createElement("patchwork-view");
  view.setAttribute("doc-url", handle.url);
  view.style.cssText = "display: flex; flex: 1; min-width: 0; min-height: 0; overflow: auto;";

  provider.appendChild(view);
  element.appendChild(provider);
  return () => provider.remove();
}
