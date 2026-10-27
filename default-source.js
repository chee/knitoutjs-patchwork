export default `
//this is javascript code that produces knitout
const knitout = require('knitout');

// need this line for kniterate
let k = new knitout.Writer({carriers:["1", "2", "3", "4", "5", "6"]});

// sample width = max_needle - min_needle
// sample width should be >20!

let min_needle = 50;
let max_needle = 80;
let rows = 40;
let main_carrier = "3";

k.in(main_carrier);

for (let r = 0; r < rows; ++r) {
	//even numbered rows knit left to right
	if (r%2 == 0) {
			for (let n = max_needle; n >= min_needle; --n){

				// knit a stitch on the front bed
				k.knit("-", "f" + n, main_carrier);
		}
	}

	//odd numbered rows knit right to left
	else {
			for (let n = min_needle; n <= max_needle; ++n){

				// knit a stitch on the front bed
				k.knit("+", "f" + n, main_carrier);
		}
	}
}

k.out(main_carrier);
`;
