package work

import (
	"context"
	"os"
	"strings"

	"cmd/go/internal/base"
	"cmd/go/internal/cfg"
	"cmd/go/internal/str"
	"internal/browserhost"
)

// browserRunOut runs a build tool in a fresh browser-host instance.
func (sh *Shell) browserRunOut(dir string, env []string, cmdargs ...any) ([]byte, error) {
	result, err := browserhost.Run(context.Background(), browserhost.Command{
		Argv: str.StringList(cmdargs...), Env: append(os.Environ(), env...), Cwd: dir,
	})
	return []byte(result.Stdout + result.Stderr), err
}

// browserToolID returns the "-V=full" line of a build tool, as toolID does for release versions.
func browserToolID(name string) string {
	result, err := browserhost.Run(context.Background(), browserhost.Command{
		Argv: str.StringList(cfg.BuildToolexec, base.Tool(name), "-V=full"), Env: os.Environ(), Cwd: ".",
	})
	if err != nil {
		base.Fatalf("go: error obtaining buildID for go tool %s: %v", name, err)
	}
	return strings.TrimSpace(result.Stdout)
}
