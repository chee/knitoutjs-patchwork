import { getFallbackTool, getRegistry } from "@inkandswitch/patchwork-plugins";

// any patchwork doc at all (a tldraw you're working from, notes, …), shown
// with the patchwork tool the pane asks for (`context.toolId`), or else
// whichever one patchwork picks for it. no repo-provider of its own: there
// should only be the one, or history goes missing.
//
// the <patchwork-view> is always told which tool, and only once that tool's
// registered: left to itself, a doc with no tool for its datatype has it
// offering to load the doc's suggestedImportUrl. we just say there's no tool,
// until one arrives with a package
export default function PatchworkPane(handle, element, context) {
  const tools = getRegistry("patchwork:tool");
  let shown = false;

  function show() {
    // once it's showing, the <patchwork-view> keeps the tool it was given
    if (shown) return;
    const doc = handle.doc();
    const type = doc?.["@patchwork"]?.type;
    let toolId = context?.toolId;
    if (!toolId && type) {
      try {
        toolId = getFallbackTool(doc)?.id;
      } catch {}
    }
    // no datatype at all: patchwork-view says what's wrong with it
    if (type && !(toolId && tools.get(toolId))) {
      element.replaceChildren(noTool(type));
      return;
    }

    shown = true;
    const view = document.createElement("patchwork-view");
    view.setAttribute("doc-url", handle.url);
    if (toolId) view.setAttribute("tool-id", toolId);
    view.style.cssText = "display: flex; flex: 1; min-width: 0; min-height: 0; overflow: auto;";
    element.replaceChildren(view);
  }

  show();
  const off = tools.on("changed", show);
  return () => {
    off();
    element.replaceChildren();
  };
}

// the "nothing's open" card, for a doc nothing here can open
function noTool(type) {
  const empty = document.createElement("div");
  empty.className = "knitoutjs-empty";
  const card = document.createElement("div");
  card.className = "knitoutjs-empty-card";
  const heading = document.createElement("h2");
  heading.className = "knitoutjs-rough";
  heading.textContent = "no tool for this";
  const kind = document.createElement("p");
  kind.append("it's a ");
  const tag = document.createElement("code");
  tag.className = "knitoutjs-empty-type";
  tag.textContent = type;
  kind.append(tag, ", and nothing here knows how to open one yet.");
  const wait = document.createElement("p");
  wait.textContent = "if a package brings a tool for it, it'll open right here.";
  card.append(heading, kind, wait);
  empty.append(card);
  return empty;
}
