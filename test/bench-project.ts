const layers = 5, width = 8;
const unseeded = ['net/url', 'html/template', 'encoding/xml', 'archive/tar', 'compress/gzip', 'go/parser', 'image/png', 'text/tabwriter'];
const name = (l: number, p: number) => `l${l}p${p}`;

function source(l: number, p: number, extra = '') {
	const deps = l === 0 ? [] : [name(l - 1, p), name(l - 1, (p + 1) % width)];
	const std = l === 0 ? [unseeded[p]!] : [];
	let text = `package ${name(l, p)}\nimport (\n\t"encoding/json"\n\t"sort"\n\t"strings"\n`;
	for (const dep of deps) text += `\t"example.test/browser/bench/${dep}"\n`;
	for (const pkg of std) text += `\t_ "${pkg}"\n`;
	text += `)\n`;
	for (let i = 0; i < 25; i++) text += `func F${i}(m map[string]int, s []string) (int, error) {\n\ttotal := ${i}\n\tfor k, v := range m {\n\t\tif strings.HasPrefix(k, "k${i}") {\n\t\t\ttotal += v * ${i}\n\t\t}\n\t}\n\tsort.Strings(s)\n\tb, err := json.Marshal(struct{ K []string; T int }{s, total})\n\tif err != nil {\n\t\treturn 0, err\n\t}\n\treturn len(b) + total, nil\n}\n`;
	for (const dep of deps) text += `var _ = ${dep}.F0\n`;
	return text + extra;
}

export const benchGoMod = 'module example.test/browser\n\ngo 1.27.0\n';
export const benchPackage = './bench';

export function benchFiles(): Record<string, string> {
	const files: Record<string, string> = {};
	for (let l = 0; l < layers; l++) for (let p = 0; p < width; p++) files[`bench/${name(l, p)}/p.go`] = source(l, p);
	const top = Array.from({ length: width }, (_, p) => name(layers - 1, p));
	files['bench/main.go'] = `package main\nimport (\n\t"fmt"\n${top.map(t => `\t"example.test/browser/bench/${t}"\n`).join('')})\nfunc main() {\n\tn := 0\n${top.map(t => `\tif v, err := ${t}.F3(map[string]int{"k3x": 2}, []string{"b", "a"}); err == nil { n += v }\n`).join('')}\tfmt.Println("bench", n)\n}\n`;
	return files;
}

export const benchEdits: { label: string; path: string; text: string }[] = [
	{ label: 'edit body of a leaf package', path: `bench/${name(0, 0)}/p.go`, text: source(0, 0).replace('total := 0', 'total := 1') },
	{ label: 'add an exported function to a leaf package', path: `bench/${name(0, 0)}/p.go`, text: source(0, 0, 'func Extra() int { return 1 }\n') },
];
