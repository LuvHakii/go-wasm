package server

import (
	"errors"
	"io"
)

func startCPUProfile(io.Writer) error { return errors.New("profiling is not supported in the browser") }

func stopCPUProfile() {}
