import {convertKnitout} from "./vendor/knitout-to-kcode.js"
import {docText, moduleWorker} from "./files.js"
import {parseSource, highlighter} from "./stitch-source.js"

const STYLESHEET = new URL("./visualizer.css", import.meta.url).href
const WORKER_URL = new URL("./visualizer-worker.js", import.meta.url)
const REDRAW_DELAY = 250

// mark where each stitch came from: its line in this .k, and the line of the
// .js that made it if the .js run said (";!source:24" becomes
// ";!source:k12/24"). see stitch-source.js
function annotateKnitout(text) {
	return text
		.split("\n")
		.map((line, index) => {
			const k = index + 1
			const fromJs = line.match(/;!source:(-?\d+)/)
			if (fromJs) return line.replace(fromJs[0], `;!source:k${k}/${fromJs[1]}`)
			const semi = line.indexOf(";")
			const op = semi === -1 ? line : line.slice(0, semi)
			return op.trim() ? `${op};!source:k${k}` : line
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

const STITCHES = {
	k: "knit",
	t: "tuck",
	m: "miss",
	x: "transfer",
	X: "transfer",
	s: "split",
	S: "split",
}
const BEDS = {f: "front bed", b: "back bed", fs: "front sliders", bs: "back sliders"}

// "knit → · front bed needle 55 · row 12 · carrier 3 · from line 24 of the .js"
function describeStitch(stitch, at) {
	if (!stitch) return ""
	const parts = []
	if (stitch.needle != null) {
		const arrow = stitch.dir === "+" ? " →" : stitch.dir === "-" ? " ←" : ""
		parts.push((STITCHES[stitch.type] ?? stitch.type ?? "stitch") + arrow)
		parts.push(`${BEDS[stitch.bed] ?? stitch.bed} needle ${stitch.needle}`)
	} else {
		parts.push(`yarn between needles ${stitch.between.join(" and ")}`)
	}
	parts.push(`row ${stitch.row}`)
	if (stitch.yarns.length) {
		parts.push(`${stitch.yarns.length > 1 ? "carriers" : "carrier"} ${stitch.yarns.join(", ")}`)
	}
	if (at?.jsLine != null) parts.push(`from line ${at.jsLine} of the .js`)
	else if (at?.kLine != null) parts.push(`line ${at.kLine} of the .k`)
	return parts.join(" · ")
}

function sizeOf(canvas) {
	const rect = canvas.getBoundingClientRect()
	return {width: rect.width, height: rect.height, dpr: devicePixelRatio}
}

// the stitches are parsed and drawn in a worker on an OffscreenCanvas. the
// canvas's own events go there to be handled; hover and double click come back
function workerRenderer(canvas, {onHover, onGoto, onFail}) {
	const offscreen = canvas.transferControlToOffscreen()
	const worker = moduleWorker(WORKER_URL)
	const parsing = new Map()
	let parses = 0
	let ready = false

	worker.postMessage({type: "init", canvas: offscreen, size: sizeOf(canvas)}, [offscreen])
	worker.onmessage = ({data}) => {
		if (data.type === "ready") ready = true
		else if (data.type === "hover") onHover(data.source, data.stitch)
		else if (data.type === "goto") onGoto(data.source)
		else if (data.type === "parsed" || data.type === "error") {
			const {resolve, reject} = parsing.get(data.id) ?? {}
			parsing.delete(data.id)
			if (data.type === "parsed") resolve?.()
			else reject?.(new Error(data.message))
		}
	}
	worker.onerror = event => {
		event.preventDefault()
		if (!ready) onFail(event.message)
	}

	const send = (type, fields) => worker.postMessage({type: "event", event: {type, ...fields}})
	const local = event => {
		const rect = canvas.getBoundingClientRect()
		return {clientX: event.clientX - rect.left, clientY: event.clientY - rect.top}
	}
	const listeners = {
		mousemove: event => send("mousemove", {...local(event), buttons: event.buttons}),
		mousedown: event => (event.preventDefault(), send("mousedown", local(event))),
		dblclick: event => send("dblclick", local(event)),
		wheel: event => (event.preventDefault(), send("wheel", {deltaY: event.deltaY, deltaMode: event.deltaMode})),
		keydown: event => {
			if (event.key === "Shift") event.preventDefault()
			send("keydown", {code: event.code})
		},
		keyup: event => send("keyup", {code: event.code}),
		mouseover: () => canvas.focus(),
	}
	canvas.tabIndex = 0
	for (const [type, listener] of Object.entries(listeners)) {
		canvas.addEventListener(type, listener, {passive: false})
	}

	return {
		parse(text, resetView) {
			const id = ++parses
			worker.postMessage({type: "parse", id, text, resetView})
			return new Promise((resolve, reject) => parsing.set(id, {resolve, reject}))
		},
		highlight: lines => worker.postMessage({type: "highlight", lines}),
		resetZoom: () => worker.postMessage({type: "resetZoom"}),
		resize: () => worker.postMessage({type: "resize", size: sizeOf(canvas)}),
		destroy() {
			worker.terminate()
			for (const [type, listener] of Object.entries(listeners)) {
				canvas.removeEventListener(type, listener)
			}
		},
	}
}

// the same, drawn on the page: for browsers without OffscreenCanvas, or if
// the worker can't start
async function pageRenderer(canvas, {onHover, onGoto}) {
	const {ShowKnitout} = await import("./vendor/show-knitout.js")
	const show = new ShowKnitout(canvas)
	show.onHoverSource = (source, stitch) => onHover(source ?? null, stitch ?? null)
	show.onDoubleClickSource = source => onGoto(source ?? null)
	return {
		parse: (text, resetView) => show.parse(text, false, resetView),
		highlight: lines => show.setHighlightFn(highlighter(lines)),
		resetZoom: () => show.resetZoom(),
		resize: () => show.requestDraw(),
		destroy() {},
	}
}

/**
 * draws the stitches in a .k file, again whenever it changes. the drawing
 * happens in a worker where the browser allows it, so a big file never holds
 * up the page.
 *
 * knitout:hover-source / knitout:select-source (a click, not a drag) /
 * knitout:goto-source (a double click) events bubble out of `element`
 * with {url, line, at}: `at` is every line the stitch came from, as {url,
 * line} (the .js that wrote this .k, and this .k); url and line are the first.
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
	root.className = "knitoutjs-editor-tool knitout-visualizer"
	element.appendChild(root)

	// watch the canvas, not root: root can already fill the pane before the
	// stylesheet loads, while the canvas is still 300x150 until it does
	const resizeObserver = new ResizeObserver(() => renderer?.resize())
	let canvas = document.createElement("canvas")
	root.appendChild(canvas)
	resizeObserver.observe(canvas)

	const actions = document.createElement("div")
	actions.className = "knitout-visualizer-actions"
	actions.append(
		button("knitout-button", "reset zoom", () => renderer?.resetZoom()),
		button("knitout-button", "export kcode", exportKcode),
	)
	const [resetButton, exportButton] = actions.children
	resetButton.title = "fit the whole piece in view again (scroll to zoom, drag to move around)"
	exportButton.title =
		"save this as a .kc file: kcode, the format a Kniterate machine reads"
	root.appendChild(actions)

	// what the stitch under the pointer is
	const stitchInfo = document.createElement("div")
	stitchInfo.className = "knitout-visualizer-stitch"
	stitchInfo.hidden = true
	root.appendChild(stitchInfo)

	const hint = document.createElement("div")
	hint.className = "knitout-visualizer-hint"
	hint.textContent =
		"point at a stitch to see what it is · click it to find its line · double click to put the cursor there · hold shift to see the back bed"
	root.appendChild(hint)

	const empty = document.createElement("div")
	empty.className = "knitout-visualizer-empty"
	empty.textContent = "no stitches yet"
	root.appendChild(empty)

	const errorBar = document.createElement("div")
	errorBar.className = "knitout-visualizer-error"
	root.appendChild(errorBar)

	// every line a stitch came from, as {url, line}: the .js line first (if
	// the .js that wrote this is known), then this .k's
	function sourcesOf(source) {
		const at = parseSource(source)
		if (!at) return []
		const jsUrl = handle.doc()?.knitoutSource
		const lines = []
		if (at.jsLine != null && jsUrl) lines.push({url: jsUrl, line: at.jsLine})
		if (at.kLine != null) lines.push({url: handle.url, line: at.kLine})
		return lines
	}

	// {url, line} for the first, and `at` with them all, so each editor finds
	// its own line
	function located(source) {
		const at = sourcesOf(source)
		return at.length ? {...at[0], at} : null
	}

	function dispatch(type, detail) {
		element.dispatchEvent(
			new CustomEvent(type, {detail, bubbles: true, composed: true}),
		)
	}

	// the stitch under the pointer
	let hovered = null

	const callbacks = {
		onHover: (source, stitch) => {
			hovered = located(source)
			dispatch("knitout:hover-source", hovered ?? {url: null, at: []})
			stitchInfo.textContent = describeStitch(stitch, parseSource(source))
			stitchInfo.hidden = !stitch
			hint.hidden = Boolean(stitch)
		},
		onGoto: source => {
			const at = located(source)
			if (at) dispatch("knitout:goto-source", at)
		},
		// the worker didn't start: draw on the page instead, on a new canvas
		// (this one belongs to the worker now)
		onFail: async message => {
			console.warn("knitout visualizer: drawing on the page instead of a worker:", message)
			renderer?.destroy()
			const fresh = document.createElement("canvas")
			resizeObserver.unobserve(canvas)
			canvas.replaceWith(fresh)
			canvas = fresh
			resizeObserver.observe(canvas)
			renderer = await pageRenderer(canvas, callbacks)
			renderer.highlight(lines)
			firstDraw = true
			draw()
		},
	}

	let renderer = null
	let lines = null
	let firstDraw = true
	let generation = 0
	let timer = null

	async function draw() {
		if (!renderer) return
		const gen = ++generation
		const text = docText(handle.doc())
		empty.hidden = text.trim() !== ""
		errorBar.hidden = true
		try {
			await renderer.parse(annotateKnitout(text), firstDraw)
		} catch (error) {
			if (gen !== generation) return
			errorBar.textContent = String(error)
			errorBar.hidden = false
			return
		}
		// fit the view to the first stitches there are, not to an empty file
		if (text.trim()) firstDraw = false
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
		const local = url === handle.url
		const fromJs = url != null && url === handle.doc()?.knitoutSource
		lines =
			start == null || (!local && !fromJs)
				? null
				: {local, start, end: end ?? start}
		renderer?.highlight(lines)
	}

	let destroyed = false
	;(async () => {
		try {
			renderer =
				"transferControlToOffscreen" in canvas && typeof Worker !== "undefined"
					? workerRenderer(canvas, callbacks)
					: await pageRenderer(canvas, callbacks)
		} catch (error) {
			return callbacks.onFail(String(error?.message ?? error))
		}
		if (destroyed) return renderer.destroy()
		draw()
	})()

	// a click is a press that doesn't move: one that does is panning
	let pressedAt = null
	function onPointerDown(event) {
		pressedAt = event.target === canvas ? {x: event.clientX, y: event.clientY} : null
	}
	function onPointerUp(event) {
		const moved = pressedAt && Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y)
		if (pressedAt && moved < 4 && hovered) dispatch("knitout:select-source", hovered)
		pressedAt = null
	}
	root.addEventListener("pointerdown", onPointerDown)
	root.addEventListener("pointerup", onPointerUp)

	handle.on("change", scheduleDraw)
	events.addEventListener("knitout:highlight-lines", onHighlightLines)

	return () => {
		destroyed = true
		generation++
		clearTimeout(timer)
		handle.off("change", scheduleDraw)
		events.removeEventListener("knitout:highlight-lines", onHighlightLines)
		resizeObserver.disconnect()
		root.removeEventListener("pointerdown", onPointerDown)
		root.removeEventListener("pointerup", onPointerUp)
		renderer?.destroy()
		root.remove()
		link.remove()
	}
}
