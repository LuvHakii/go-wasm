package gocommand

import (
	"context"
	"golang.org/x/tools/internal/browserhost"
	"io"
	"os"
)

func (i *Invocation) runGoCommand(ctx context.Context, stdout, stderr io.Writer, goArgs []string) error {
	env := []string{}
	if !i.CleanEnv {
		env = os.Environ()
	}
	env = append(env, i.Env...)
	dir := i.WorkingDir
	if dir == "" {
		dir, _ = os.Getwd()
	}
	result, err := browserhost.Run(ctx, browserhost.Command{Argv: append([]string{"go"}, goArgs...), Env: env, Cwd: dir})
	if _, writeErr := io.WriteString(stdout, result.Stdout); writeErr != nil {
		return writeErr
	}
	if _, writeErr := io.WriteString(stderr, result.Stderr); writeErr != nil {
		return writeErr
	}
	return err
}
