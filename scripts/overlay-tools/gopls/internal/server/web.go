package server

import (
	"context"
	"errors"

	"golang.org/x/tools/gopls/internal/golang"
	"golang.org/x/tools/gopls/internal/protocol"
)

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
