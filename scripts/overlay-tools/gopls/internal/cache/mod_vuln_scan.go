package cache

import (
	"context"
	"errors"

	"golang.org/x/tools/gopls/internal/vulncheck/osv"
)

func osvsByModule(ctx context.Context, db, moduleVersion string) ([]*osv.Entry, error) {
	return nil, errors.New("vulnerability database queries are unavailable in the browser")
}
