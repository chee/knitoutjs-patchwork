import {stylesheet} from "./stylesheet.js"

// the colours of carriers 1–6: the kniterate editor's, until someone picks
// their own
export const YARNS = ["#ec7418", "#4fc6ef", "#f8cf1d", "#f597df", "#0c56a5", "#56aa30"]
// what's in each carrier is kept in the .k, as `yarns`: for each of carriers
// 1–6, null (the usual: one strand, its usual colour) or {colours: [the
// first strand's, and a second strand's fed through the same carrier with
// it, if there is one], plated (the two through the plating slit, the first
// on the face: see strands.js) or held together}. every tool showing yarns
// hears when it changes
export const YARNS_CHANGED = "lattice:yarns"
// (what this browser picked, before they were kept in the .k: what a .k that
// hasn't any of its own shows, until someone picks)
const STORE = "lattice:kniterate-yarns"
const STRANDS = "lattice:kniterate-strands"

function stored(key) {
	try {
		const value = JSON.parse(localStorage.getItem(key))
		return Array.isArray(value) ? value : []
	} catch {
		return []
	}
}

const isColour = value => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)

// what's in each of carriers 1–6, from a .k's doc: [{colours, plated}]
export function yarnStrands(doc) {
	const kept = Array.isArray(doc?.yarns) ? doc.yarns : null
	const picked = stored(STORE)
	const second = stored(STRANDS)
	return YARNS.map((usual, index) => {
		if (kept) {
			const yarn = kept[index]
			const colours = Array.from(yarn?.colours ?? []).filter(isColour).slice(0, 2)
			return colours.length ? {colours, plated: colours.length > 1 && !!yarn.plated} : {colours: [usual], plated: false}
		}
		const first = isColour(picked[index]) ? picked[index] : usual
		const other = isColour(second[index]?.colour) ? second[index].colour : null
		return other ? {colours: [first, other], plated: !!second[index].plated} : {colours: [first], plated: false}
	})
}

// the colours of carriers 1–6 (their first strands')
export function yarnColours(doc) {
	return yarnStrands(doc).map(({colours}) => colours[0])
}

// change what's in carrier `index` (0–5) of the .k: a yarn ({colours,
// plated}), or null for the usual
function storeYarn(handle, index, yarn) {
	const shown = yarnStrands(handle.doc())
	handle.change(doc => {
		// (the first time, it keeps what was showing, for all six)
		if (!Array.isArray(doc.yarns)) doc.yarns = shown.map(({colours, plated}) => ({colours, plated}))
		while (doc.yarns.length < YARNS.length) doc.yarns.push(null)
		doc.yarns[index] = yarn ? {colours: [...yarn.colours], plated: yarn.colours.length > 1 && !!yarn.plated} : null
	})
	// (the pickers on this .k hear of it, and tell the tools)
}

const STYLESHEET = new URL("./yarns.css", import.meta.url).href
// (dragging about in a colour picker: how long it waits, after the last
// colour, to keep it)
const KEEP_DELAY = 120

/**
 * a swatch for each carrier of the .k `handle` shows, in its yarn's colour,
 * for a tool's bar. click one to pick its colour; with `strands` (a tool that
 * can show them), to give it a second strand of another colour too, plated
 * or held together. `destroy()` stops it listening
 */
export function yarnPicker({handle, strands = false}) {
	const element = document.createElement("div")
	element.className = "yarn-picker"

	const link = stylesheet(STYLESHEET)

	const chips = YARNS.map((_, index) => {
		const chip = document.createElement("button")
		chip.className = "yarn-chip"
		chip.textContent = String(index + 1)
		chip.setAttribute("aria-haspopup", "dialog")
		chip.addEventListener("click", () => toggle(index))
		return chip
	})

	// ── the carrier's popover: its strand (or strands), and how they're fed

	const popover = document.createElement("div")
	popover.className = "yarn-popover"
	popover.popover = "auto"
	popover.setAttribute("role", "dialog")
	const heading = document.createElement("div")
	heading.className = "yarn-heading"

	function swatch() {
		const row = document.createElement("div")
		row.className = "yarn-row"
		const label = document.createElement("label")
		const input = document.createElement("input")
		input.type = "color"
		input.className = "yarn-swatch"
		const text = document.createElement("span")
		const hex = document.createElement("code")
		hex.className = "yarn-hex"
		label.append(input, text, hex)
		row.append(label)
		return {row, input, text, hex}
	}
	const first = swatch()
	const second = swatch()
	second.text.textContent = "second strand"
	const removeSecond = document.createElement("button")
	removeSecond.className = "yarn-button yarn-remove"
	removeSecond.textContent = "×"
	removeSecond.title = "back to one strand"
	second.row.append(removeSecond)
	const addSecond = document.createElement("button")
	addSecond.className = "yarn-button yarn-add"
	addSecond.textContent = "+ second strand"
	addSecond.title = "feed a second strand, of another colour, through this carrier with it (2-ply)"

	const feed = document.createElement("div")
	feed.className = "yarn-feed"
	feed.setAttribute("role", "radiogroup")
	feed.setAttribute("aria-label", "how the two strands are fed")
	const feedOption = (plated, label, title) => {
		const button = document.createElement("button")
		button.className = "yarn-button"
		button.textContent = label
		button.title = title
		button.setAttribute("role", "radio")
		button.addEventListener("click", () => {
			const yarn = current()
			if (yarn.colours.length > 1) keep({...yarn, plated})
		})
		return button
	}
	const held = feedOption(false, "held together", "the two strands side by side, rolling over each other as they go")
	const plated = feedOption(true, "plated", "through the plating slit: the first strand on the face, the second behind it")
	feed.append(held, plated)

	const reset = document.createElement("button")
	reset.className = "yarn-button yarn-reset"
	reset.textContent = "usual colour"
	reset.title = "one strand, in this carrier's usual colour"
	reset.addEventListener("click", () => keep(null))

	popover.append(heading, first.row, ...(strands ? [second.row, addSecond, feed] : []), reset)

	// (which carrier's showing in it)
	let open = null
	// (and what's in it: what's being picked, if it's not kept yet)
	const current = () => (pending?.index === open ? pending.yarn : yarnStrands(handle.doc())[open])

	let pending = null
	let timer = null
	function keep(yarn) {
		clearTimeout(timer)
		pending = null
		storeYarn(handle, open, yarn)
	}
	// a colour, while it's being picked: shown at once, kept once it stops
	function picking(yarn) {
		pending = {index: open, yarn}
		paint()
		clearTimeout(timer)
		timer = setTimeout(flush, KEEP_DELAY)
	}
	function flush() {
		clearTimeout(timer)
		if (!pending) return
		const {index, yarn} = pending
		pending = null
		storeYarn(handle, index, yarn)
	}

	first.input.addEventListener("input", () => {
		const yarn = current()
		picking({...yarn, colours: [first.input.value, ...yarn.colours.slice(1)]})
	})
	second.input.addEventListener("input", () => {
		const yarn = current()
		picking({...yarn, colours: [yarn.colours[0], second.input.value]})
	})
	first.input.addEventListener("change", flush)
	second.input.addEventListener("change", flush)
	addSecond.addEventListener("click", () => {
		const yarn = current()
		// (white, unless the first is near enough white: then near black)
		const [r, g, b] = [1, 3, 5].map(at => parseInt(yarn.colours[0].slice(at, at + 2), 16))
		const light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 200
		keep({colours: [yarn.colours[0], light ? "#222222" : "#ffffff"], plated: false})
		second.input.focus()
	})
	removeSecond.addEventListener("click", () => {
		keep({colours: [current().colours[0]], plated: false})
		first.input.focus()
	})

	// (pressing a chip closes an open popover before its click comes: so a
	// click on the chip whose popover that was only closes it)
	let closed = null
	function toggle(index) {
		if (open === index && popover.matches(":popover-open")) {
			popover.hidePopover()
			return
		}
		if (closed?.index === index && performance.now() - closed.at < 400) {
			closed = null
			return
		}
		flush()
		open = index
		paint()
		const rect = chips[index].getBoundingClientRect()
		popover.showPopover()
		const width = popover.offsetWidth
		const left = Math.max(8, Math.min(rect.left, innerWidth - width - 8))
		popover.style.left = `${left}px`
		popover.style.top = `${rect.bottom + 6}px`
	}
	popover.addEventListener("toggle", event => {
		if (event.newState === "closed") {
			closed = {index: open, at: performance.now()}
			flush()
			open = null
			paint()
		}
	})

	element.append(link, ...chips, popover)

	function paint() {
		const yarns = yarnStrands(handle.doc())
		if (pending) yarns[pending.index] = pending.yarn
		yarns.forEach(({colours, plated}, index) => {
			const chip = chips[index]
			chip.style.setProperty("--yarn", colours[0])
			const two = strands && colours.length > 1
			chip.classList.toggle("two", two)
			chip.classList.toggle("plated", two && plated)
			if (two) chip.style.setProperty("--yarn-2", colours[1])
			chip.setAttribute("aria-expanded", String(open === index))
			chip.title = `carrier ${index + 1}: ${two ? `two strands, ${plated ? "plated" : "held together"}` : "one strand"}. click to change`
		})
		if (open == null) return
		const {colours, plated: isPlated} = yarns[open]
		const two = strands && colours.length > 1
		heading.textContent = `carrier ${open + 1}`
		// (not while it's being picked: that would fight the picker)
		if (document.activeElement !== first.input) first.input.value = colours[0]
		first.hex.textContent = colours[0]
		first.text.textContent = two ? "first strand" : "yarn"
		second.row.hidden = !two
		feed.hidden = !two
		addSecond.hidden = two
		if (two) {
			if (document.activeElement !== second.input) second.input.value = colours[1]
			second.hex.textContent = colours[1]
			held.setAttribute("aria-checked", String(!isPlated))
			plated.setAttribute("aria-checked", String(isPlated))
		}
	}
	paint()
	addEventListener(YARNS_CHANGED, paint)

	// someone else's picks, in the same .k
	let seen = JSON.stringify(handle.doc()?.yarns ?? null)
	function onChange() {
		const now = JSON.stringify(handle.doc()?.yarns ?? null)
		if (now === seen) return
		seen = now
		dispatchEvent(new Event(YARNS_CHANGED))
	}
	handle.on("change", onChange)

	return {
		element,
		destroy() {
			flush()
			removeEventListener(YARNS_CHANGED, paint)
			handle.off("change", onChange)
		},
	}
}
