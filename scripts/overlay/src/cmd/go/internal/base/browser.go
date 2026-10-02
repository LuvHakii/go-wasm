package base

import (
	"fmt"
	"go/build"
	"path/filepath"

	"cmd/go/internal/cfg"
)

// browserToolPath names the build tools the browser host provides.
func browserToolPath(name string) (string, error) {
	switch name {
	case "compile", "link", "asm":
		return filepath.Join(build.ToolDir, name) + cfg.ToolExeSuffix(), nil
	}
	return "", fmt.Errorf("unsupported browser tool: %s", name)
}
