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
	"path/filepath"
	"strings"
)

var toolsDeletes = []string{
	"gopls/internal/debug/flight.go",
	"gopls/internal/debug/rpc.go",
	"gopls/internal/debug/serve.go",
	"gopls/internal/debug/trace.go",
	"gopls/internal/golang/assembly.go",
}

var toolsRules = []struct {
	file  string
	edits []edit
}{
	{"gopls/internal/cache/mod_vuln.go", []edit{dropDecls(
		"type osvReader", "func osvReader.Config", "func osvReader.Finding", "func osvReader.OSV", "func osvReader.Progress", "func osvsByModule")}},
	{"gopls/internal/debug/info.go", []edit{dropDecls("func Instance.writeServerInfo")}},
	{"gopls/internal/filecache/filecache.go", []edit{replaceBody("hashExecutable", `data, err := hex.DecodeString(os.Getenv("BROWSER_TOOL_SHA256"))
if err != nil || len(data) != len(hash) {
	return hash, fmt.Errorf("missing or invalid browser executable SHA-256")
}
copy(hash[:], data)
return hash, nil`, "encoding/hex")}},
	{"gopls/internal/server/command.go", []edit{
		replaceRange("commandHandler.StartDebugging", "debug.GetInstance", "di.Serve", `listenedAddr, err := serveDebug(ctx, addr)`),
		renameSelectors("pprof", map[string]string{"StartCPUProfile": "startCPUProfile", "StopCPUProfile": "stopCPUProfile"}),
		renameSelectors("scan", map[string]string{"RunGovulncheck": "runGovulncheck"}),
	}},
	{"gopls/internal/server/prompt.go", []edit{
		dropDecls(
			"const FakeSamplesPerMille", "const FakeTelemetryModefileEnvvar", "const GoTelemetryGoplsClientStartTimeEnvvar",
			"const GoTelemetryGoplsClientTokenEnvvar", "const TelemetryNo", "const TelemetryPromptWorkTitle", "const TelemetryYes",
			"const gracePeriod", "const promptTimeout", "const samplesPerMille",
			"func acquireLockFile", "func server.getenv", "func server.setTelemetryMode", "func server.telemetryMode", "func telemetryOnMessage"),
		replaceBody("server.maybePromptForTelemetry", ""),
	}},
	{"gopls/internal/server/server.go", []edit{dropDecls(
		"func server.getWeb", "func server.initWeb", "func web.PkgURL", "func web.SrcURL", "func web.assemblyURL", "func web.freesymbolsURL",
		"func web.splitpkgURL", "func web.url", "func withPanicHandler", "type web", "var assets")}},
	{"gopls/internal/settings/staticcheck.go", []edit{
		dropKeyed("staticcheckAnalyzers", "sa1008.SCAnalyzer"),
		hoistArg("staticcheckAnalyzers", "addAll", "staticcheck", "config", "saUpstream"),
	}},
	{"internal/gocommand/invoke.go", []edit{replaceRange("Invocation.run", "exec.Command", "", `return i.runGoCommand(ctx, stdout, stderr, goArgs)`)}},
}

func runTools(dir string) {
	for _, f := range toolsDeletes {
		if err := os.Remove(filepath.Join(dir, f)); err != nil {
			log.Fatalf("%v (update scripts/trim/tools.go for this golang/tools revision)", err)
		}
	}
	for _, r := range toolsRules {
		rewrite(filepath.Join(dir, r.file), r.edits)
	}
}

func recvName(fd *ast.FuncDecl) string {
	if fd.Recv == nil || len(fd.Recv.List) == 0 {
		return ""
	}
	t := fd.Recv.List[0].Type
	if s, ok := t.(*ast.StarExpr); ok {
		t = s.X
	}
	if id, ok := t.(*ast.Ident); ok {
		return id.Name
	}
	return ""
}

func dropDecls(names ...string) edit {
	return func(fset *token.FileSet, f *ast.File) error {
		want := map[string]bool{}
		for _, n := range names {
			want[n] = true
		}
		var kept []ast.Decl
		var gone []ast.Node
		drop := func(d ast.Decl, doc *ast.CommentGroup) {
			gone = append(gone, d)
			if doc != nil {
				gone = append(gone, doc)
			}
		}
		for _, d := range f.Decls {
			switch d := d.(type) {
			case *ast.FuncDecl:
				key := "func " + d.Name.Name
				if r := recvName(d); r != "" {
					key = "func " + r + "." + d.Name.Name
				}
				if want[key] {
					delete(want, key)
					drop(d, d.Doc)
					continue
				}
			case *ast.GenDecl:
				if d.Tok == token.IMPORT {
					break
				}
				var specs []ast.Spec
				for _, s := range d.Specs {
					key := ""
					switch s := s.(type) {
					case *ast.TypeSpec:
						key = "type " + s.Name.Name
					case *ast.ValueSpec:
						if len(s.Names) == 1 {
							key = d.Tok.String() + " " + s.Names[0].Name
						}
					}
					if key != "" && want[key] {
						delete(want, key)
						gone = append(gone, s)
						continue
					}
					specs = append(specs, s)
				}
				if len(specs) == 0 {
					drop(d, d.Doc)
					continue
				}
				d.Specs = specs
			}
			kept = append(kept, d)
		}
		if len(want) > 0 {
			missing := make([]string, 0, len(want))
			for n := range want {
				missing = append(missing, n)
			}
			return fmt.Errorf("declarations not found: %v", missing)
		}
		f.Decls = kept
		var comments []*ast.CommentGroup
	next:
		for _, c := range f.Comments {
			for _, n := range gone {
				if c.Pos() >= n.Pos() && c.End() <= n.End() {
					continue next
				}
			}
			comments = append(comments, c)
		}
		f.Comments = comments
		return nil
	}
}

func replaceRange(fn, from, to, src string) edit {
	return func(fset *token.FileSet, f *ast.File) error {
		stub, err := parser.ParseFile(fset, "stub.go", "package p\nfunc _() {\n"+src+"\n}", 0)
		if err != nil {
			return err
		}
		body := stub.Decls[0].(*ast.FuncDecl).Body.List
		text := func(s ast.Stmt) string {
			var b bytes.Buffer
			format.Node(&b, fset, s)
			return b.String()
		}
		for _, fd := range findFunc(f, fn) {
			list := fd.Body.List
			start, end := -1, -1
			for i, s := range list {
				if start < 0 && strings.Contains(text(s), from) {
					start = i
				}
				if start >= 0 && end < 0 && to != "" && strings.Contains(text(s), to) {
					end = i
				}
			}
			if to == "" {
				end = len(list) - 1
			}
			if start < 0 || end < start {
				return fmt.Errorf("statements %q..%q not found in %s", from, to, fn)
			}
			dropComments(f, list[start].Pos(), list[end].End())
			rest := append([]ast.Stmt{}, list[end+1:]...)
			fd.Body.List = append(append(list[:start:start], body...), rest...)
			return nil
		}
		return fmt.Errorf("func %s not found", fn)
	}
}

func dropKeyed(fn string, drop ...string) edit {
	return func(_ *token.FileSet, f *ast.File) error {
		removed := 0
		for _, fd := range findFunc(f, fn) {
			ast.Inspect(fd.Body, func(n ast.Node) bool {
				lit, ok := n.(*ast.CompositeLit)
				if !ok {
					return true
				}
				var kept []ast.Expr
				for _, e := range lit.Elts {
					if kv, ok := e.(*ast.KeyValueExpr); ok {
						if sel, ok := kv.Key.(*ast.SelectorExpr); ok {
							if x, ok := sel.X.(*ast.Ident); ok && contains(drop, x.Name+"."+sel.Sel.Name) {
								removed++
								continue
							}
						}
					}
					kept = append(kept, e)
				}
				lit.Elts = kept
				return true
			})
		}
		if removed != len(drop) {
			return fmt.Errorf("removed %d of %v keyed elements in %s", removed, drop, fn)
		}
		return nil
	}
}

func hoistArg(fn, call, first, name, wrap string) edit {
	return func(_ *token.FileSet, f *ast.File) error {
		for _, fd := range findFunc(f, fn) {
			for i, s := range fd.Body.List {
				es, ok := s.(*ast.ExprStmt)
				if !ok {
					continue
				}
				c, ok := es.X.(*ast.CallExpr)
				if !ok || len(c.Args) != 3 {
					continue
				}
				if id, ok := c.Fun.(*ast.Ident); !ok || id.Name != call || str(c.Args[0]) != first {
					continue
				}
				config := ast.NewIdent(name)
				assign := &ast.AssignStmt{Lhs: []ast.Expr{ast.NewIdent(name)}, Tok: token.DEFINE, Rhs: []ast.Expr{c.Args[2]}}
				c.Args[1] = &ast.CallExpr{Fun: ast.NewIdent(wrap), Args: []ast.Expr{ast.NewIdent(name)}}
				c.Args[2] = config
				fd.Body.List = append(fd.Body.List[:i:i], append([]ast.Stmt{assign}, fd.Body.List[i:]...)...)
				return nil
			}
		}
		return fmt.Errorf("%s(%q, ...) call not found in %s", call, first, fn)
	}
}

func dropComments(f *ast.File, lo, hi token.Pos) {
	var kept []*ast.CommentGroup
	for _, c := range f.Comments {
		if c.Pos() >= lo && c.End() <= hi {
			continue
		}
		kept = append(kept, c)
	}
	f.Comments = kept
}
