// Copyright 2026 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package pprof

import (
	"errors"
	"io"
)

var errUnsupported = errors.New("profiling is not supported in the browser build")

type Profile struct{}

func Lookup(string) *Profile { return &Profile{} }

func (*Profile) WriteTo(io.Writer, int) error { return errUnsupported }

func StartCPUProfile(io.Writer) error { return errUnsupported }

func StopCPUProfile() {}

func WriteHeapProfile(io.Writer) error { return errUnsupported }
