package server

import (
	"context"
	"errors"
)

func serveDebug(ctx context.Context, addr string) (string, error) {
	return "", errors.New("the debug server is unavailable in the browser")
}
