// a tool's stylesheet, as a <link> for the tool's element (so it's styled
// even in a shadow root). once it's loaded the page keeps a copy in its head,
// so the next tool to use it (switching from one visualizer to another, say)
// is styled from its first frame, not a frame or two after. till then, root
// (what it styles) is hidden: nothing, rather than a flash of it unstyled

const kept = new Set()

export function stylesheet(href, root = null) {
	const link = document.createElement("link")
	link.rel = "stylesheet"
	link.href = href
	if (kept.has(href)) return link
	if (root) root.style.visibility = "hidden"
	const show = () => {
		if (root) root.style.visibility = ""
	}
	link.addEventListener("load", () => {
		show()
		if (kept.has(href)) return
		kept.add(href)
		const keep = document.createElement("link")
		keep.rel = "stylesheet"
		keep.href = href
		document.head.append(keep)
	}, {once: true})
	link.addEventListener("error", show, {once: true})
	return link
}
