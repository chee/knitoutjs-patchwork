import {ShowKnitout} from "./vendor/show-knitout.js"
import {highlighter} from "./stitch-source.js"

// draws stitches on an OffscreenCanvas, off the page's thread. the page sends
// its pointer, wheel and key events here, and they're dispatched on the
// offscreen canvas so show-knitout handles them as if they were its own.
//
// in:  {type: "init", canvas, size} · {type: "resize", size}
//      {type: "parse", id, text, resetView} · {type: "highlight", lines}
//      {type: "resetZoom"} · {type: "event", event: {type, ...fields}}
// out: {type: "ready"} · {type: "parsed", id} · {type: "error", id, message}
//      {type: "hover", source, stitch} · {type: "goto", source}

let show
let canvas
let size = {width: 1, height: 1, dpr: 1}

onmessage = async ({data}) => {
	if (data.type === "init") {
		canvas = data.canvas
		size = data.size
		show = new ShowKnitout(canvas)
		show.viewport = () => ({left: 0, top: 0, ...size})
		show.onHoverSource = (source, stitch) =>
			postMessage({type: "hover", source: source ?? null, stitch: stitch ?? null})
		show.onDoubleClickSource = source => postMessage({type: "goto", source: source ?? null})
		postMessage({type: "ready"})
		return
	}
	if (!show) return
	if (data.type === "resize") {
		size = data.size
		show.requestDraw()
	} else if (data.type === "parse") {
		try {
			await show.parse(data.text, false, data.resetView)
			postMessage({type: "parsed", id: data.id})
		} catch (error) {
			postMessage({type: "error", id: data.id, message: String(error?.message ?? error)})
		}
	} else if (data.type === "highlight") {
		show.setHighlightFn(highlighter(data.lines))
	} else if (data.type === "resetZoom") {
		show.resetZoom()
	} else if (data.type === "event") {
		const {type, ...fields} = data.event
		const event = new Event(type, {cancelable: true})
		Object.assign(event, fields)
		canvas.dispatchEvent(event)
	}
}
