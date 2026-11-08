// which tab each group shows. it's this browser's, not the doc's: kept in
// localStorage by layout doc and group, so a reload finds it, and passed
// round a BroadcastChannel, so this browser's other tabs follow along.
// switching tabs writes nothing to the doc
const key = (layoutUrl) => `latticework:active:${layoutUrl}`;

// {[group id]: panel id}
export function readActive(layoutUrl) {
  try {
    const active = JSON.parse(localStorage.getItem(key(layoutUrl)) ?? "{}");
    return active && typeof active === "object" && !Array.isArray(active) ? active : {};
  } catch {
    return {};
  }
}

export function writeActive(layoutUrl, active) {
  try {
    if (Object.keys(active).length) localStorage.setItem(key(layoutUrl), JSON.stringify(active));
    else localStorage.removeItem(key(layoutUrl));
  } catch {}
}

// for a layout just made from an old tree, which kept its active tabs in it
export function seedActive(layoutUrl, active) {
  if (active && Object.keys(active).length) writeActive(layoutUrl, active);
}

// tells the others with this layout open which tab a group's showing, and
// hears from them. returns {post(groupId, panelId), close()}
export function activeChannel(layoutUrl, onShow) {
  let channel = null;
  try {
    channel = new BroadcastChannel(key(layoutUrl));
    channel.onmessage = ({ data }) => {
      if (typeof data?.group === "string" && typeof data?.panel === "string") onShow(data.group, data.panel);
    };
  } catch {}
  return {
    post(group, panel) {
      try {
        channel?.postMessage({ group, panel });
      } catch {}
    },
    close() {
      channel?.close();
    },
  };
}
