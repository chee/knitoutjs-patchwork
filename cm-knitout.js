import {StateEffect, StateField} from "@codemirror/state"
import {EditorView, Decoration, ViewPlugin, WidgetType} from "@codemirror/view"

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

// the line a build failed on, until the code changes: tinted, with what
// went wrong written at its end
const setErrorLine = StateEffect.define()

class ErrorMessage extends WidgetType {
	constructor(message) {
		super()
		this.message = message
	}
	eq(other) {
		return other.message === this.message
	}
	toDOM() {
		const span = document.createElement("span")
		span.className = "cm-knitout-error-message"
		span.textContent = `⚠ ${this.message}`
		return span
	}
}

const errorLineField = StateField.define({
	create() {
		return Decoration.none
	},
	update(decorations, tr) {
		if (tr.docChanged) decorations = Decoration.none
		for (const effect of tr.effects) {
			if (!effect.is(setErrorLine)) continue
			if (effect.value == null) {
				decorations = Decoration.none
			} else {
				const lineNumber = Math.max(1, Math.min(effect.value.line, tr.state.doc.lines))
				const line = tr.state.doc.line(lineNumber)
				decorations = Decoration.set([
					Decoration.line({
						class: "cm-knitout-error-line",
						attributes: {title: effect.value.message},
					}).range(line.from),
					Decoration.widget({
						widget: new ErrorMessage(effect.value.message),
						side: 1,
					}).range(line.to),
				])
			}
		}
		return decorations
	},
	provide: field => EditorView.decorations.from(field),
})

/**
 * mark the line a run failed on ({line, message}), or clear it (null). it
 * clears itself when the code changes
 */
export function showError(view, error) {
	const effects = [setErrorLine.of(error)]
	if (error) {
		const lineNumber = Math.max(1, Math.min(error.line, view.state.doc.lines))
		effects.push(
			EditorView.scrollIntoView(view.state.doc.line(lineNumber).from, {y: "nearest"}),
		)
	}
	view.dispatch({effects})
}

const knitoutTheme = EditorView.baseTheme({
	".cm-knitout-error-line": {
		backgroundColor:
			"color-mix(in oklab, var(--studio-danger, #d33a4c) 14%, transparent)",
		boxShadow: "inset 3px 0 0 var(--studio-danger, #d33a4c)",
	},
	".cm-knitout-error-message": {
		marginLeft: "2ch",
		color: "var(--studio-danger, #d33a4c)",
		fontStyle: "italic",
	},
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
 *   frame's root element). each event says which files and lines it means,
 *   as `detail.at` ([{url, line}]) or just `detail.url` and `detail.line`;
 *   only the line for `url` moves this editor
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

		// the line in this editor's file, if the event has one ({url, line},
		// or several in `at`)
		function lineFor(detail) {
			const at = detail?.at ?? [detail]
			return at.find(entry => entry?.url === url)?.line ?? null
		}

		// pointing at a stitch lights up its line, but never moves the editor:
		// scrolling along with the pointer is too much motion
		function onHover(event) {
			view.dispatch({effects: setHoverLine.of(lineFor(event.detail))})
		}

		// a click on a stitch: scroll its line into view
		function onSelect(event) {
			const lineNumber = lineFor(event.detail)
			if (lineNumber == null) return
			view.dispatch({
				effects: EditorView.scrollIntoView(lineAt(lineNumber).from, {
					y: "nearest",
					yMargin: 48,
				}),
			})
		}

		// double click on a stitch: jump to the line that made it, and put the
		// cursor there
		function onGoto(event) {
			const lineNumber = lineFor(event.detail)
			if (lineNumber == null) return
			const line = lineAt(lineNumber)
			view.dispatch({
				selection: {anchor: line.from},
				effects: EditorView.scrollIntoView(line.from, {y: "center"}),
			})
			view.focus()
		}

		events.addEventListener("knitout:hover-source", onHover)
		events.addEventListener("knitout:select-source", onSelect)
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
				events.removeEventListener("knitout:select-source", onSelect)
				events.removeEventListener("knitout:goto-source", onGoto)
			},
		}
	})

	return [plugin, hoverLineField, errorLineField, knitoutTheme]
}
