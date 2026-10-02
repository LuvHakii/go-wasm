package work

import "time"

// analysisModule mirrors golang.org/x/tools/go/analysis.Module for the vet
// config JSON. The browser build never runs vet, and importing go/analysis
// would link all of go/types into the go command.
type analysisModule struct {
	Path      string
	Version   string
	Replace   *analysisModule
	Time      *time.Time
	Main      bool
	Indirect  bool
	Dir       string
	GoMod     string
	GoVersion string
	Error     *analysisModuleError
}

type analysisModuleError struct {
	Err string
}
