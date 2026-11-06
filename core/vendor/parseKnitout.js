"use strict";
//parseKnitout will parse knitout, catch syntax errors, and dispatch to calls on 'machine', an abstract knitting machine:
const KO_NEEDLE_RE  = /^([fb]s?)([-+]?\d+)$/;
const KO_NUMBER_RE  = /^[-+]?(\.\d+|\d+.\d*|\d+)$/;
const KO_HEADER_RE  = /^;;([^:]+): (.*)$/;
const KO_VERSION_RE = /^;!knitout-(\d+)$/;
const KO_CARRIER_OPS = new Set(["in", "out", "inhook", "releasehook", "outhook"]);
const koValidNeedles = new Set(); // needles we've already validated

function koCheckCarrierSet(tokens, start, carrierNames) {
	const cs = [];
	for (let i = start; i < tokens.length; ++i) {
		const name = tokens[i];
		if (carrierNames.indexOf(name) === -1) throw "Carrier name does not appear in Carriers header.";
		if (cs.indexOf(name) !== -1) throw "Carrier name appears twice in carrier set.";
		cs.push(name);
	}
	return cs;
}
function koCheckNumber(token, label) {
	if (!KO_NUMBER_RE.test(token)) {
		throw label + " value [" + token + "] must be a simple floating point value.";
	}
	return parseFloat(token);
}
function koCheckDirection(token) {
	if (!(token === '-' || token === '+')) throw "Direction [" + token + "] must be '+' or '-'.";
	return token;
}
function koCheckNeedle(token) {
	if (koValidNeedles.has(token)) return token;
	if (!KO_NEEDLE_RE.test(token)) throw "Needle [" + token + "] must be f,b,fs, or bs followed by an integer.";
	koValidNeedles.add(token);
	return token;
}

// split on spaces/tabs into a reused array (replaces split(/[ \t]+/) + trim)
function koTokenize(text, tokens) {
	tokens.length = 0;
	const n = text.length;
	let i = 0;
	while (i < n) {
		let c = text.charCodeAt(i);
		if (c === 32 || c === 9) { ++i; continue; }
		let j = i + 1;
		while (j < n) {
			c = text.charCodeAt(j);
			if (c === 32 || c === 9) break;
			++j;
		}
		tokens.push(text.substring(i, j));
		i = j;
	}
}

function nextFrame() {
	return new Promise(function(resolve) {
		//patchwork: workers may not have requestAnimationFrame
		if (globalThis.requestAnimationFrame) requestAnimationFrame(function() { setTimeout(resolve, 0); });
		else setTimeout(resolve, 0);
	});
}

async function parseKnitout(codeText, machine, useKnitoutAsSource=false, opts={}) {
	const SLICE_MS = 12;           // how long to work before yielding
	const CHECK_EVERY = 256;       // lines between clock checks
	let sliceStart = performance.now();

	//setup
	const errors = [];
	const warnings = [];
	let carrierNames = [];
	let inCommentHeader = true;
	let end = false;
	const hasSource = 'source' in machine;
	const tokens = []; // reused for every line

	if (codeText.indexOf("\r\n") !== -1) {
		console.log("Found a DOS/Windows-style CRLF line ending. These aren't allowed by the knitout specification; but this parser will ignore them.");
	}

	function addError(lineNumber, info) {
		console.log("Parse Error on line " + lineNumber + ": " + info);
		errors.push({lineNumber:lineNumber, text:info});
	}
	function addWarning(lineNumber, info) {
		console.log("Parse Warning on line " + lineNumber + ": " + info);
		warnings.push({lineNumber:lineNumber, text:info});
	}

	const lines = codeText.split(/\r?\n/);

		for (let lineNumber = 0; lineNumber < lines.length && !end; ++lineNumber) {
		if ((lineNumber & (CHECK_EVERY - 1)) === 0 && performance.now() - sliceStart > SLICE_MS) {
			if (opts.onProgress) opts.onProgress(lineNumber / lines.length);
			await nextFrame();
			if (opts.isCancelled && opts.isCancelled()) return null;   // a newer run started
			sliceStart = performance.now();
		}

		const line = lines[lineNumber];

		// first line
		if (lineNumber === 0) {
			const m = KO_VERSION_RE.exec(line);
			if (m !== null) {
				if (parseInt(m[1]) != 2) {
					addWarning(lineNumber, "Parsed version (" + m[1] + ") is not what was expected.");
				}
			} else {
				addError(lineNumber, "Knitout should always start with a ';!knitout-2' line.");
			}
			continue;
		}

		//comment header lines (only lines starting with ';;' can match):
		if (line.charCodeAt(0) === 59 && line.charCodeAt(1) === 59) {
			const m = KO_HEADER_RE.exec(line);
			if (m !== null) {
				if (!inCommentHeader) {
					addWarning(lineNumber, "Comment-header-like line outside comment header.");
				} else {
					if (m[1] === "Carriers") {
						carrierNames = m[2].split(" ");
						machine.setCarriers(carrierNames);
					}
					continue;
				}
			} else {
				inCommentHeader = false;
			}
		} else {
			inCommentHeader = false;
		}

		//split into op part and comment part at the first ';':
		const semi = line.indexOf(';');
		const opText = (semi === -1 ? line : line.substring(0, semi));

		//handle !source: directive in comment
		if (semi !== -1 && line.startsWith(';!source:', semi)) {
			if (hasSource) machine.source(line.substring(semi + 9));
		} else if (useKnitoutAsSource) {
			machine.source(lineNumber);
		}

		koTokenize(opText, tokens);
		if (tokens.length === 0) continue; //empty operation

		const op = tokens[0];
		const argc = tokens.length - 1;

		try {
			if (op === "knit" || op === "drop" || op === "tuck" || op === "amiss") {
				const isKnit = (op === "knit" || op === "drop");
				const implied = (op === "drop" || op === "amiss"); //direction is implied '+'
				let d, ni;
				if (implied) {
					if (argc !== 1) throw op + " takes exactly one argument";
					d = '+'; ni = 1;
				} else {
					if (argc < 2) throw op + " requires at least two arguments";
					d = koCheckDirection(tokens[1]); ni = 2;
				}
				const n = koCheckNeedle(tokens[ni]);
				const cs = koCheckCarrierSet(tokens, ni + 1, carrierNames);
				if (isKnit) machine.knit(d, n, cs); else machine.tuck(d, n, cs);
			} else if (op === "miss") {
				if (argc < 2) throw "miss requires at least two arguments";
				const d = koCheckDirection(tokens[1]);
				const n = koCheckNeedle(tokens[2]);
				machine.miss(d, n, koCheckCarrierSet(tokens, 3, carrierNames));
			} else if (op === "split" || op === "xfer") {
				let d, ni;
				if (op === "xfer") {
					if (argc !== 2) throw "xfer takes exactly two arguments";
					d = '+'; ni = 1;
				} else {
					if (argc < 3) throw "split requires at least three arguments";
					d = koCheckDirection(tokens[1]); ni = 2;
				}
				const n = koCheckNeedle(tokens[ni]);
				const n2 = koCheckNeedle(tokens[ni + 1]);
				machine.split(d, n, n2, koCheckCarrierSet(tokens, ni + 2, carrierNames));
			} else if (KO_CARRIER_OPS.has(op)) {
				machine[op](koCheckCarrierSet(tokens, 1, carrierNames));
			} else if (op === "stitch") {
				if (argc !== 2) throw "stitch takes exactly two arguments";
				machine.stitch(koCheckNumber(tokens[1], "Stitch"), koCheckNumber(tokens[2], "Stitch"));
			} else if (op === "rack") {
				if (argc !== 1) throw "rack takes exactly one argument";
				machine.rack(koCheckNumber(tokens[1], "Racking"));
			} else if (op === "pause") {
				if (argc !== 0) throw "pause takes no arguments";
				machine.pause();
			} else if (op === "x-end") {
				end = true;
			} else if (op === "x-yarn-in" || op === "x-yarn-out" || op === "x-loop-in") {
				if (argc < 3) throw op + " requires at least three arguments";
				const d = koCheckDirection(tokens[1]);
				const n = koCheckNeedle(tokens[2]);
				const cs = koCheckCarrierSet(tokens, 3, carrierNames);
				if (op === "x-yarn-in") machine.yarnInEdge(d, n, cs);
				else if (op === "x-yarn-out") machine.yarnOutEdge(d, n, cs);
				else machine.loopInEdge(d, n, cs);
			} else if (op === "x-loop-out") {
				if (argc !== 1) throw "x-loop-out requires one argument";
				machine.loopOutEdge(koCheckNeedle(tokens[1]));
			} else if (op.startsWith("x-")) {
				if (op in machine) {
					machine[op](...tokens.slice(1));
				}
			} else {
				addError(lineNumber, "Unrecognized operation.");
			}
		} catch (e) {
			if (typeof(e) === "string") {
				addError(lineNumber, e);
			} else {
				addError(lineNumber, "[error that wasn't a string]");
				throw e;
			}
		}
	}
	return {errors:errors, warnings:warnings};
}

export { parseKnitout };
