package server

import (
	"context"
	"errors"
	"io"

	"golang.org/x/tools/gopls/internal/cache"
	"golang.org/x/tools/gopls/internal/golang"
	"golang.org/x/tools/gopls/internal/protocol"
	"golang.org/x/tools/gopls/internal/vulncheck"
)

func serveDebug(ctx context.Context, addr string) (string, error) {
	return "", errors.New("the debug server is unavailable in the browser")
}

func runGovulncheck(ctx context.Context, pattern string, snapshot *cache.Snapshot, dir string, out io.Writer) (*vulncheck.Result, error) {
	return nil, errors.New("govulncheck is unavailable in the browser")
}

func startCPUProfile(io.Writer) error { return errors.New("profiling is not supported in the browser") }

func stopCPUProfile() {}

type web struct{ server webServer }

type webServer struct{}

func (webServer) Shutdown(context.Context) error { return nil }

func (s *server) getWeb() (*web, error) {
	return nil, errors.New("the web UI is unavailable in the browser")
}

func (w *web) SrcURL(filename string, line, col8 int) protocol.URI { return "" }

func (w *web) PkgURL(viewID string, path golang.PackagePath, fragment string) protocol.URI {
	return ""
}

func (w *web) freesymbolsURL(viewID string, loc protocol.Location) protocol.URI { return "" }

func (w *web) assemblyURL(viewID, packageID, symbol string) protocol.URI { return "" }

func (w *web) splitpkgURL(viewID, packageID string) protocol.URI { return "" }
