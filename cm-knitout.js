import {
	StateEffect,
	StateField,
	EditorView,
	Decoration,
	ViewPlugin,
} from "./vendor/codemirror.js"

const setHoverLine = StateEffect.define()

const hoverLineDecoration = Decoration.line({class: "cm-knitout-hover-line"})

const hoverLineField = StateField.define({
	create() {
		return Decoration.none
	},
	update(decorations, tr) {
		decorations = decorations.map(tr.changes)
		for (const effect of tr.effects) {
			if (effect.is(setHoverLine)) {
				if (effect.value == null) {
					decorations = Decoration.none
				} else {
					const lineNumber = Math.max(
						1,
						Math.min(effect.value, tr.state.doc.lines)
					)
					const line = tr.state.doc.line(lineNumber)
					decorations = Decoration.set([
						hoverLineDecoration.range(line.from),
					])
				}
			}
		}
		return decorations
	},
	provide: field => EditorView.decorations.from(field),
})

const knitoutTheme = EditorView.baseTheme({
	".cm-knitout-hover-line": {
		backgroundColor: "rgba(255, 220, 0, 0.25)",
	},
	"&dark .cm-knitout-hover-line": {
		backgroundColor: "rgba(255, 220, 0, 0.15)",
	},
})

/**
 * two-way glue between a codemirror editor and knitout visualizers.
 *
 * options:
 * - events: an element the visualizers' knitout:* events reach (e.g. the
 *   frame's root element). each event says which file it means in
 *   `detail.url`; only the ones for `url` move this editor
 * - url: the automerge url of the file this editor shows
 * - onSelectLines: ({url, start, end}) => void, called with 1-based inclusive
 *   line numbers whenever the editor selection changes — forward this to the
 *   visualizers as a knitout:highlight-lines event
 */
export function knitoutEditorIntegration({events, url, onSelectLines}) {
	const plugin = ViewPlugin.define(view => {
		function lineAt(lineNumber) {
			const clamped = Math.max(1, Math.min(lineNumber, view.state.doc.lines))
			return view.state.doc.line(clamped)
		}

		function onHover(event) {
			if (event.detail?.url !== url) {
				view.dispatch({effects: setHoverLine.of(null)})
				return
			}
			const lineNumber = event.detail?.line
			view.dispatch({
				effects: setHoverLine.of(lineNumber ?? null),
			})
		}

		// double click on a stitch: jump to the line that made it
		// (single click is left alone because dragging pans the canvas)
		function onGoto(event) {
			if (event.detail?.url !== url) return
			const lineNumber = event.detail?.line
			if (lineNumber == null) return
			const line = lineAt(lineNumber)
			view.dispatch({
				selection: {anchor: line.from},
				effects: EditorView.scrollIntoView(line.from, {y: "center"}),
			})
			view.focus()
		}

		events.addEventListener("knitout:hover-source", onHover)
		events.addEventListener("knitout:goto-source", onGoto)

		return {
			update(update) {
				if (update.selectionSet && onSelectLines) {
					const main = update.state.selection.main
					onSelectLines({
						url,
						start: update.state.doc.lineAt(main.from).number,
						end: update.state.doc.lineAt(main.to).number,
					})
				}
			},
			destroy() {
				events.removeEventListener("knitout:hover-source", onHover)
				events.removeEventListener("knitout:goto-source", onGoto)
			},
		}
	})

	return [plugin, hoverLineField, knitoutTheme]
}
