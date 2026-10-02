package server

import (
	"context"
	"errors"
	"io"

	"golang.org/x/tools/gopls/internal/cache"
	"golang.org/x/tools/gopls/internal/vulncheck"
)

func runGovulncheck(ctx context.Context, pattern string, snapshot *cache.Snapshot, dir string, out io.Writer) (*vulncheck.Result, error) {
	return nil, errors.New("govulncheck is unavailable in the browser")
}
