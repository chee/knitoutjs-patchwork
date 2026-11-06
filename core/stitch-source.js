// where a stitch came from, as the visualizer marks it: "k12" is line 12 of
// the .k it's drawn from; "k12/24" is line 12 of the .k, which line 24 of the
// .js that wrote it made; a bare "24" is line 24 of that .js

export function parseSource(source) {
	const text = String(source ?? "")
	const both = text.match(/^k(\d+)(?:\/(-?\d+))?$/)
	if (both) {
		return {kLine: Number(both[1]), jsLine: both[2] == null ? null : Number(both[2])}
	}
	const jsLine = parseInt(text)
	return Number.isFinite(jsLine) ? {kLine: null, jsLine} : null
}

// which stitches to light up for some lines: {local, start, end} (local: lines
// of the .k, otherwise of the .js), or null for none. it's plain data so it
// can go to a worker
export function highlighter(lines) {
	if (!lines) return () => false
	return source => {
		const at = parseSource(source)
		const line = lines.local ? at?.kLine : at?.jsLine
		return line != null && line >= lines.start && line <= lines.end
	}
}
