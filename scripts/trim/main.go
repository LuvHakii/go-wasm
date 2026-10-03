// Command trim rewrites a pristine Go source tree for the browser build.
//
// Deletions are anchored by name (function, variable, switch key, selector),
// never by line number or diff context, so they survive Go version bumps.
// Insertions live in scripts/rules/*.yml.
// A target that no longer exists is a hard error naming the rule to update.
//
// Usage: go run ./scripts/trim [-stubobj] GOROOT_COPY
//
// -stubobj also reduces the non-wasm cmd/internal/obj/* packages to their
// constants. Only the compiler needs them (for register numbers in generated
// code), and the assembler needs the real packages, so build asm first.
package main

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"log"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/tools/go/ast/astutil"
)

type edit func(fset *token.FileSet, f *ast.File) error

var rules = []struct {
	file  string
	edits []edit
}{
	// Compiler, linker, assembler: wasm backend only.
	{"cmd/compile/main.go", []edit{keepMapKeys("archInits", "wasm")}},
	{"cmd/link/main.go", []edit{keepCases("main", "wasm")}},
	{"cmd/asm/internal/arch/arch.go", []edit{keepCases("Set", "wasm")}},
	{"cmd/compile/internal/ssa/config.go", []edit{keepCases("NewConfig", "wasm")}},

	// go command: go/analysis (and go/types with it) is only used for vet config types.
	{"cmd/go/internal/work/exec.go", []edit{renameSelectors("analysis", map[string]string{"Module": "analysisModule", "ModuleError": "analysisModuleError"})}},

	// go command: the browser needs only build, list, env, version, mod, work.
	{"cmd/go/main.go", []edit{dropElements("init",
		"bug.CmdBug", "clean.CmdClean", "doc.CmdDoc", "vet.CmdFix", "fmtcmd.CmdFmt", "generate.CmdGenerate",
		"modget.CmdGet", "work.CmdInstall", "run.CmdRun", "test.CmdTest", "tool.CmdTool", "vet.CmdVet",
		"test.HelpTestflag", "test.HelpTestfunc", "modget.HelpVCS")}},

	{"cmd/compile/internal/gc/util.go", []edit{rewriteImport("runtime/pprof", stubPprof)}},
	{"cmd/link/internal/ld/main.go", []edit{rewriteImport("runtime/pprof", stubPprof)}},
	{"cmd/link/internal/benchmark/bench.go", []edit{rewriteImport("runtime/pprof", stubPprof)}},

	{"cmd/link/internal/loadelf/ldelf.go", []edit{replaceBody("Load", unsupported)}},
	{"cmd/link/internal/loadmacho/ldmacho.go", []edit{replaceBody("Load", unsupported)}},
	{"cmd/link/internal/loadpe/ldpe.go", []edit{replaceBody("Load", unsupported)}},
	{"cmd/link/internal/loadxcoff/ldxcoff.go", []edit{replaceBody("Load", unsupported)}},

	{"cmd/go/internal/modfetch/codehost/vcs.go", []edit{replaceBody("NewRepo", `return nil, errors.New("version control is not supported in the browser")`, "errors")}},
	{"cmd/go/internal/vcs/vcs.go", []edit{
		replaceBody("RepoRootForImportPath", `return nil, errors.New("module discovery is not supported in the browser")`, "errors"),
		replaceBody("FromDir", `return "", nil, &vcsNotFoundError{dir: dir}`),
	}},
	{"cmd/internal/buildid/note.go", []edit{
		replaceBody("readELF", "return readRaw(name, data)"),
		replaceBody("readMacho", "return readRaw(name, data)"),
	}},
	{"cmd/internal/buildid/buildid.go", []edit{
		replaceBody("readGccgoArchive", `return "", errors.New("gccgo archives are not supported in the browser build")`, "errors"),
		replaceBody("readGccgoBigArchive", `return "", errors.New("gccgo archives are not supported in the browser build")`, "errors"),
	}},
	{"cmd/internal/buildid/rewrite.go", []edit{
		replaceBody("findMachoCodeSignature", "return nil, codesign.CodeSigCmd{}, false"),
		replaceBody("findHostBuildID", "return 0, 0, false"),
	}},
	{"cmd/go/internal/work/action.go", []edit{replaceBody("readpkglist", "base.Fatalf(\"shared libraries are not supported in the browser build\")\nreturn")}},
	{"cmd/go/internal/version/version.go", []edit{replaceBody("scanFile", "if mustPrint {\n\tfmt.Fprintf(os.Stderr, \"%s: reading binaries is not supported in the browser\\n\", file)\n}\nreturn false")}},
}

const stubPprof = "cmd/internal/stub/pprof"

var remove = []string{"cmd/go/internal/lockedfile/internal/filelock/filelock_other.go"}

func main() {
	args := os.Args[1:]
	if len(args) == 2 && args[0] == "-tools" {
		runTools(args[1])
		return
	}
	stubObj := len(args) > 0 && args[0] == "-stubobj"
	if stubObj {
		args = args[1:]
	}
	if len(args) != 1 {
		log.Fatal("usage: trim [-stubobj] GOROOT_COPY | trim -tools TOOLS_CHECKOUT")
	}
	src := filepath.Join(args[0], "src")
	if stubObj {
		for _, arch := range []string{"arm64", "riscv", "ppc64", "s390x", "loong64", "x86", "arm", "mips"} {
			constsOnly(filepath.Join(src, "cmd/internal/obj", arch))
		}
		// Their rewrite functions are unreachable once NewConfig keeps only wasm,
		// and they call into the assemblers that were just reduced to constants.
		deleteGlobs(filepath.Join(src, "cmd/compile/internal/ssa"), "rewrite386*.go", "rewriteAMD64*.go", "rewriteARM*.go", "rewriteLOONG64*.go", "rewriteMIPS*.go", "rewritePPC64*.go", "rewriteRISCV64*.go", "rewriteS390X*.go")
		return
	}
	for _, r := range rules {
		rewrite(filepath.Join(src, r.file), r.edits)
	}
	for _, f := range remove {
		if err := os.Remove(filepath.Join(src, f)); err != nil {
			log.Fatalf("%v (update scripts/trim/main.go for this Go version)", err)
		}
	}
}

func rewrite(file string, edits []edit) {
	data, err := os.ReadFile(file)
	if err != nil {
		log.Fatal(err)
	}
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, file, data, parser.ParseComments)
	if err != nil {
		log.Fatal(err)
	}
	for _, e := range edits {
		if err := e(fset, f); err != nil {
			log.Fatalf("%s: %v (update the rule in scripts/trim for this revision)", file, err)
		}
	}
	pruneImports(fset, f)
	var buf bytes.Buffer
	if err := format.Node(&buf, fset, f); err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(file, buf.Bytes(), 0o644); err != nil {
		log.Fatal(err)
	}
}

func findFunc(f *ast.File, name string) []*ast.FuncDecl {
	recv, name := "", name
	if i := strings.Index(name, "."); i >= 0 {
		recv, name = name[:i], name[i+1:]
	}
	var out []*ast.FuncDecl
	for _, d := range f.Decls {
		if fd, ok := d.(*ast.FuncDecl); ok && fd.Name.Name == name && fd.Body != nil && recvName(fd) == recv {
			out = append(out, fd)
		}
	}
	return out
}

func str(e ast.Expr) string {
	if l, ok := e.(*ast.BasicLit); ok && l.Kind == token.STRING {
		s, _ := strconv.Unquote(l.Value)
		return s
	}
	return ""
}

// keepMapKeys keeps only the listed string keys of the map literal assigned to variable name.
func keepMapKeys(name string, keys ...string) edit {
	return func(_ *token.FileSet, f *ast.File) error {
		found := false
		ast.Inspect(f, func(n ast.Node) bool {
			vs, ok := n.(*ast.ValueSpec)
			if !ok || len(vs.Names) != 1 || vs.Names[0].Name != name || len(vs.Values) != 1 {
				return true
			}
			lit, ok := vs.Values[0].(*ast.CompositeLit)
			if !ok {
				return true
			}
			found = true
			var kept []ast.Expr
			for _, e := range lit.Elts {
				if kv, ok := e.(*ast.KeyValueExpr); ok && contains(keys, str(kv.Key)) {
					kept = append(kept, e)
				}
			}
			if len(kept) != len(keys) {
				found = false
			}
			lit.Elts = kept
			return false
		})
		if !found {
			return fmt.Errorf("map %s with keys %v not found", name, keys)
		}
		return nil
	}
}

// keepCases keeps the listed string cases (and default) of the first switch in function fn.
func keepCases(fn string, keys ...string) edit {
	return func(_ *token.FileSet, f *ast.File) error {
		for _, fd := range findFunc(f, fn) {
			var sw *ast.SwitchStmt
			ast.Inspect(fd.Body, func(n ast.Node) bool {
				if s, ok := n.(*ast.SwitchStmt); ok && sw == nil {
					sw = s
				}
				return sw == nil
			})
			if sw == nil {
				continue
			}
			var kept []ast.Stmt
			seen := 0
			for _, s := range sw.Body.List {
				cc := s.(*ast.CaseClause)
				if cc.List == nil {
					kept = append(kept, cc)
					continue
				}
				for _, e := range cc.List {
					if contains(keys, str(e)) {
						cc.List = []ast.Expr{e}
						kept = append(kept, cc)
						seen++
						break
					}
				}
			}
			if seen != len(keys) {
				return fmt.Errorf("switch in %s lacks cases %v", fn, keys)
			}
			sw.Body.List = kept
			return nil
		}
		return fmt.Errorf("func %s with a switch not found", fn)
	}
}

// dropElements removes elements of the first composite literal in fn that are selector X.Sel in drop.
func dropElements(fn string, drop ...string) edit {
	return func(_ *token.FileSet, f *ast.File) error {
		for _, fd := range findFunc(f, fn) {
			removed := 0
			ast.Inspect(fd.Body, func(n ast.Node) bool {
				lit, ok := n.(*ast.CompositeLit)
				if !ok {
					return true
				}
				var kept []ast.Expr
				for _, e := range lit.Elts {
					if sel, ok := e.(*ast.SelectorExpr); ok {
						if x, ok := sel.X.(*ast.Ident); ok && contains(drop, x.Name+"."+sel.Sel.Name) {
							removed++
							continue
						}
					}
					kept = append(kept, e)
				}
				lit.Elts = kept
				return true
			})
			if removed != len(drop) {
				return fmt.Errorf("func %s: dropped %d of %d elements %v", fn, removed, len(drop), drop)
			}
			return nil
		}
		return fmt.Errorf("func %s not found", fn)
	}
}

// rewriteImport points an import at another package with the same name.
func rewriteImport(from, to string) edit {
	return func(fset *token.FileSet, f *ast.File) error {
		if !astutil.RewriteImport(fset, f, from, to) {
			return fmt.Errorf("import %q not found", from)
		}
		return nil
	}
}

// replaceBody replaces the body of a top-level function with the statements in src.
// The linker then drops everything only that function used. Imports that src needs are added.
func replaceBody(fn, src string, imports ...string) edit {
	return func(fset *token.FileSet, f *ast.File) error {
		stub, err := parser.ParseFile(fset, "stub.go", "package p\nfunc _() {\n"+src+"\n}", 0)
		if err != nil {
			return err
		}
		body := stub.Decls[0].(*ast.FuncDecl).Body.List
		n := 0
		for _, fd := range findFunc(f, fn) {
			dropComments(f, fd.Body.Lbrace, fd.Body.Rbrace)
			fd.Body.List = body
			n++
		}
		if n == 0 {
			return fmt.Errorf("func %s not found", fn)
		}
		for _, imp := range imports {
			astutil.AddImport(fset, f, imp)
		}
		return nil
	}
}

const unsupported = `panic("unsupported in the browser build")`

// pruneImports drops imports whose package name is no longer referenced.
func pruneImports(fset *token.FileSet, f *ast.File) {
	used := map[string]bool{}
	ast.Inspect(f, func(n ast.Node) bool {
		if sel, ok := n.(*ast.SelectorExpr); ok {
			if x, ok := sel.X.(*ast.Ident); ok {
				used[x.Name] = true
			}
		}
		return true
	})
	for _, imp := range append([]*ast.ImportSpec{}, f.Imports...) { // astutil mutates f.Imports
		p, _ := strconv.Unquote(imp.Path.Value)
		name := path.Base(p)
		if imp.Name != nil {
			if imp.Name.Name == "_" || imp.Name.Name == "." {
				continue
			}
			name = imp.Name.Name
		}
		if !used[name] {
			if imp.Name != nil {
				astutil.DeleteNamedImport(fset, f, imp.Name.Name, p)
			} else {
				astutil.DeleteImport(fset, f, p)
			}
		}
	}
}

func contains(list []string, s string) bool {
	for _, l := range list {
		if l == s {
			return true
		}
	}
	return false
}

// renameSelectors rewrites pkg.Sel to a local identifier, so the import can be pruned.
func renameSelectors(pkg string, to map[string]string) edit {
	return func(_ *token.FileSet, f *ast.File) error {
		n := 0
		astutil.Apply(f, func(c *astutil.Cursor) bool {
			if sel, ok := c.Node().(*ast.SelectorExpr); ok {
				if x, ok := sel.X.(*ast.Ident); ok && x.Name == pkg {
					if name, ok := to[sel.Sel.Name]; ok {
						c.Replace(ast.NewIdent(name))
						n++
					}
				}
			}
			return true
		}, nil)
		if n == 0 {
			return fmt.Errorf("no %s.* selectors to rename", pkg)
		}
		return nil
	}
}

// constsOnly keeps only const and type declarations (plus CanBeAnSSAAux methods) of a package.
func constsOnly(dir string) {
	files, err := filepath.Glob(filepath.Join(dir, "*.go"))
	if err != nil || len(files) == 0 {
		log.Fatalf("%s: no Go files (update scripts/trim/main.go for this Go version)", dir)
	}
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			os.Remove(file)
			continue
		}
		data, err := os.ReadFile(file)
		if err != nil {
			log.Fatal(err)
		}
		fset := token.NewFileSet()
		f, err := parser.ParseFile(fset, file, data, parser.ParseComments)
		if err != nil {
			log.Fatal(err)
		}
		var kept []ast.Decl
		substantive := false
		for _, d := range f.Decls {
			switch d := d.(type) {
			case *ast.GenDecl:
				if d.Tok == token.IMPORT {
					kept = append(kept, d)
				} else if d.Tok == token.CONST || d.Tok == token.TYPE {
					kept = append(kept, d)
					substantive = true
				}
			case *ast.FuncDecl:
				if d.Recv != nil && d.Name.Name == "CanBeAnSSAAux" {
					kept = append(kept, d)
					substantive = true
				}
			}
		}
		// A constant may be computed from a variable, as in const n = len(table); keep those variables.
		used := map[string]bool{}
		for _, d := range kept {
			if g, ok := d.(*ast.GenDecl); ok && g.Tok == token.CONST {
				ast.Inspect(g, func(n ast.Node) bool {
					if id, ok := n.(*ast.Ident); ok {
						used[id.Name] = true
					}
					return true
				})
			}
		}
		for _, d := range f.Decls {
			if g, ok := d.(*ast.GenDecl); ok && g.Tok == token.VAR {
				for _, s := range g.Specs {
					for _, name := range s.(*ast.ValueSpec).Names {
						if used[name.Name] {
							kept = append(kept, g)
							substantive = true
							goto nextDecl
						}
					}
				}
			}
		nextDecl:
		}
		if !substantive {
			os.Remove(file)
			continue
		}
		f.Decls = kept
		pruneImports(fset, f)
		var buf bytes.Buffer
		if err := format.Node(&buf, fset, f); err != nil {
			log.Fatal(err)
		}
		if err := os.WriteFile(file, buf.Bytes(), 0o644); err != nil {
			log.Fatal(err)
		}
	}
}

func deleteGlobs(dir string, patterns ...string) {
	n := 0
	for _, p := range patterns {
		files, _ := filepath.Glob(filepath.Join(dir, p))
		for _, f := range files {
			os.Remove(f)
			n++
		}
	}
	if n == 0 {
		log.Fatalf("%s: nothing matched %v (update scripts/trim/main.go for this Go version)", dir, patterns)
	}
}
