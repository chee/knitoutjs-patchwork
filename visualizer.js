import {ShowKnitout} from "./vendor/show-knitout.js"
import {convertKnitout} from "./vendor/knitout-to-kcode.js"
import {docText} from "./files.js"

const STYLESHEET = new URL("./visualizer.css", import.meta.url).href
const REDRAW_DELAY = 250

// mark where each stitch came from. lines the .js run wrote already say
// ";!source:<js line>"; every other operation gets ";!source:k<k line>"
function annotateKnitout(text) {
	return text
		.split("\n")
		.map((line, index) => {
			if (line.includes(";!source:")) return line
			const semi = line.indexOf(";")
			const op = semi === -1 ? line : line.slice(0, semi)
			return op.trim() ? op + ";!source:k" + (index + 1) : line
		})
		.join("\n")
}

function saveFile(text, filename) {
	const url = URL.createObjectURL(new Blob([text], {type: "text/plain"}))
	const link = document.createElement("a")
	link.href = url
	link.download = filename
	link.click()
	URL.revokeObjectURL(url)
}

function button(className, text, onClick) {
	const element = document.createElement("button")
	element.className = className
	element.textContent = text
	element.addEventListener("click", onClick)
	return element
}

/**
 * draws the stitches in a .k file, again whenever it changes.
 *
 * knitout:hover-source / knitout:goto-source events bubble out of `element`
 * with {url, line}: the url is this .k file, or the .js file that wrote it.
 * knitout:highlight-lines events with {url, start, end} arriving at
 * `context.events` (default: `element`) light up the stitches those lines
 * made.
 */
export default function KnitoutVisualizerTool(handle, element, context = {}) {
	const events = context.events ?? element

	const link = document.createElement("link")
	link.rel = "stylesheet"
	link.href = STYLESHEET
	element.appendChild(link)

	const root = document.createElement("div")
	root.className = "knitout-visualizer"
	element.appendChild(root)

	const canvas = document.createElement("canvas")
	root.appendChild(canvas)

	const actions = document.createElement("div")
	actions.className = "knitout-visualizer-actions"
	actions.append(
		button("knitout-button", "reset zoom", () => show.resetZoom()),
		button("knitout-button", "export kcode", exportKcode),
	)
	root.appendChild(actions)

	const empty = document.createElement("div")
	empty.className = "knitout-visualizer-empty"
	empty.textContent = "no stitches yet"
	root.appendChild(empty)

	const errorBar = document.createElement("div")
	errorBar.className = "knitout-visualizer-error"
	root.appendChild(errorBar)

	const show = new ShowKnitout(canvas)

	// "k12" is line 12 of this file; "12" is line 12 of the .js that wrote it
	function sourceOf(source) {
		const text = String(source ?? "")
		const local = text.startsWith("k")
		const line = parseInt(local ? text.slice(1) : text)
		if (!Number.isFinite(line)) return null
		const url = local ? handle.url : handle.doc()?.knitoutSource
		return url ? {url, line} : null
	}

	function dispatch(type, detail) {
		element.dispatchEvent(
			new CustomEvent(type, {detail, bubbles: true, composed: true}),
		)
	}

	show.onHoverSource = source => {
		dispatch("knitout:hover-source", sourceOf(source) ?? {url: null})
	}
	show.onDoubleClickSource = source => {
		const at = sourceOf(source)
		if (at) dispatch("knitout:goto-source", at)
	}

	let firstDraw = true
	let generation = 0
	let timer = null

	async function draw() {
		const gen = ++generation
		const text = docText(handle.doc())
		empty.hidden = text.trim() !== ""
		errorBar.hidden = true
		try {
			await show.parse(annotateKnitout(text), false, firstDraw)
		} catch (error) {
			if (gen !== generation) return
			errorBar.textContent = String(error)
			errorBar.hidden = false
			return
		}
		firstDraw = false
	}

	function scheduleDraw() {
		clearTimeout(timer)
		timer = setTimeout(draw, REDRAW_DELAY)
	}

	async function exportKcode() {
		const doc = handle.doc()
		const name = (doc?.name ?? "pattern.k").replace(/\.k$/, "")
		saveFile(await convertKnitout(docText(doc), name), name + ".kc")
	}

	function onHighlightLines(event) {
		const {url, start, end} = event.detail ?? {}
		if (start == null) {
			show.setHighlightFn(() => false)
			return
		}
		const last = end ?? start
		show.setHighlightFn(source => {
			const at = sourceOf(source)
			return at?.url === url && at.line >= start && at.line <= last
		})
	}

	handle.on("change", scheduleDraw)
	events.addEventListener("knitout:highlight-lines", onHighlightLines)
	const resizeObserver = new ResizeObserver(() => show.requestDraw())
	resizeObserver.observe(root)
	draw()

	return () => {
		generation++
		clearTimeout(timer)
		handle.off("change", scheduleDraw)
		events.removeEventListener("knitout:highlight-lines", onHighlightLines)
		resizeObserver.disconnect()
		root.remove()
		link.remove()
	}
}
